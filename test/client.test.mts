import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import {
  activeSessionRefusal,
  clientRewindBoundary,
  extractMessagePayload,
  fallbackImageName,
  hasNonTurnActivity,
  inheritedInboxIds,
  isUserChatNode,
  parsePrepareResponse,
  turnOf,
} from '../src/client/content.ts'
import { labels, namespace } from '../src/client/labels.ts'

const LOCALE_TITLES = {
  de: 'Schweigen ist Gold',
  en: 'Left Unsaid',
  es: 'En boca cerrada',
  fr: 'Les écrits attendent',
  ja: '言わぬが花',
  pt: 'Nem dito nem feito',
  ru: 'Пока слово не вылетело',
  zh: '君子未言',
}

let registration
const reactStub = {
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: current => ({ current }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useSyncExternalStore: (_sub, getSnapshot) => getSnapshot(),
}
const jsxStub = {
  Fragment: Symbol('Fragment'),
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
}
const domStub = { createPortal: node => node }
const primitivesStub = {
  Button: 'Button',
  IconWarningOutlineRegular: 'IconWarningOutlineRegular',
  Modal: 'Modal',
  Toast: 'Toast',
  Tooltip: 'Tooltip',
}

;(globalThis as { window?: unknown }).window = {
  __ModuleLoader__: {
    load: (entry) => { registration = entry },
  },
}
try {
  await import('../client.js')
} finally {
  delete (globalThis as { window?: unknown }).window
}

const plugin = registration.factory((name) => {
  switch (name) {
    case 'react':
      return reactStub
    case 'react/jsx-runtime':
      return jsxStub
    case 'react-dom':
      return domStub
    case '@deepseek-ai/dsh-client-ui-primitives':
      return primitivesStub
    default:
      throw new Error(`Unexpected external import ${name}`)
  }
})

function placeholders(template) {
  return [...template.matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort()
}

function makeHarness({
  fetchImpl = async () => new Response('{}', { status: 404 }),
  workspacesState = {
    items: [{ workspaceId: 'ws-1', path: '/repo', sessionIds: ['s-1'] }],
    pinnedSessionIds: [],
    archivedSessionIds: [],
  },
  sessionsById = {
    's-1': { id: 's-1', cwd: '/repo', title: 'Original Chat', projectionValues: { agentPreset: 'coder' } },
  },
  turns = new Map([[1, { end: { seq: 5 } }]]),
  olderPages = [],
  inbox = { 'next-turn': [], 'next-step': [] },
  readAttachmentImpl = async () => ({ ok: false }),
  forkImpl = async () => 's-fork',
  createImpl = async () => 's-fresh',
  archiveImpl = async () => {},
  unarchiveImpl = async () => {},
} = {}) {
  const calls = []
  const disposers = []
  const slots = new Map()
  const registeredLocales = new Map()
  const removedQueueItems = []
  const draftInitCalls = []
  const focused = []
  const olderQueue = [...olderPages]
  let childInbox = inbox
  let retainedUsingDepth = 0
  let hasMore = olderQueue.length > 0

  const sourceBinding = {
    sessionId: 's-1',
    ctx: { tag: 'source-ctx' },
    session: {
      getSnapshot: () => ({ hasMore, historyLoadStatus: 'idle' }),
      loadOlder: async () => {
        calls.push(['loadOlder'])
        const nextPage = olderQueue.shift()
        hasMore = olderQueue.length > 0
        if (nextPage !== undefined) {
          for (const [k, v] of nextPage) turns.set(k, v)
        }
      },
      readAttachment: readAttachmentImpl,
    },
  }

  const childBinding = id => ({
    sessionId: id,
    ctx: { tag: `child-ctx-${id}` },
    session: {
      projections: {
        faceOf: faceName => ({
          getSnapshot: () => (faceName === 'inbox' ? childInbox : undefined),
        }),
      },
      updateQueue: async (itemId, op) => {
        removedQueueItems.push([itemId, op])
        calls.push(['updateQueue', itemId, op.kind])
        if (op.kind === 'remove') {
          childInbox = {
            'next-turn': (childInbox['next-turn'] ?? []).filter(i => i.id !== itemId),
            'next-step': (childInbox['next-step'] ?? []).filter(i => i.id !== itemId),
          }
        }
      },
    },
  })

  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    locale: {
      register(ns, dict) {
        registeredLocales.set(ns, dict)
        return () => { registeredLocales.delete(ns) }
      },
    },
    slots: {
      inject(_name, register) {
        return register()
      },
      register(options, component) {
        slots.set(options.name, { options, component })
        return () => { slots.delete(options.name) }
      },
    },
    sessions: {
      list: { getSnapshot: () => ({ byId: sessionsById }) },
      binding(id) {
        if (id === 's-1') return sourceBinding
        return undefined
      },
      async fork(req) {
        calls.push(['fork', req])
        return forkImpl(req)
      },
      async create(req) {
        calls.push(['create', req])
        return createImpl(req)
      },
      async using(id, opts, fn) {
        calls.push(['using.enter', id, opts.source, retainedUsingDepth])
        retainedUsingDepth += 1
        try {
          return await fn({
            ready: Promise.resolve(),
            binding: childBinding(id),
          })
        } finally {
          retainedUsingDepth -= 1
          calls.push(['using.exit', id])
        }
      },
    },
    conversation: {
      input: {
        requestDraftInitialization(_binding, opts) {
          draftInitCalls.push(opts)
          calls.push(['draftInit', opts])
          return 'applied'
        },
        for(targetCtx) {
          return {
            tag: targetCtx.tag,
            focus() { focused.push(targetCtx.tag) },
          }
        },
      },
    },
    uiConversation: {
      binding(binding) {
        assert.equal(binding, sourceBinding)
        return {
          target(name) {
            assert.equal(name, 'chat')
            return { getSnapshot: () => ({ timeline: { turns } }) }
          },
        }
      },
    },
    workspaces: {
      list: { getSnapshot: () => workspacesState },
      async insertSessionBefore(workspaceId, childId, anchorId) {
        calls.push(['insertSessionBefore', workspaceId, childId, anchorId])
      },
    },
    uiWorkspace: {
      async pinSession(id) {
        calls.push(['pinSession', id])
      },
      openSession(id) {
        calls.push(['openSession', id, retainedUsingDepth > 0])
      },
      async archiveSession(id, opts) {
        calls.push(['archiveSession', id, opts])
        return archiveImpl(id, opts)
      },
      async unarchiveSession(id) {
        calls.push(['unarchiveSession', id])
        return unarchiveImpl(id)
      },
    },
  }

  const prevFetch = globalThis.fetch
  globalThis.fetch = fetchImpl
  try {
    plugin.apply(ctx)
  } finally {
    globalThis.fetch = prevFetch
  }

  const { controller } = slots.get('conversation.chat.user.before').options.inject()
  const overlayComponent = slots.get('shell.overlay').component
  return {
    calls,
    slots,
    registeredLocales,
    removedQueueItems,
    draftInitCalls,
    focused,
    controller,
    renderOverlay: (t = key => labels.en[key]) => overlayComponent({ controller, t }),
    dispose() {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

function userNode({ turn, seq, content }) {
  return {
    kind: 'user',
    key: `user-${seq}`,
    location: { kind: 'step', turn: { turn }, step: { step: 1 } },
    data: { seq, content },
  }
}

test('client plugin registers expected slots, selects only user rows, preserves 8-locale parity/branding, and uses rewind glyph', () => {
  assert.equal(registration.id, '@miorin/dsh-session-rewind')
  assert.deepEqual(plugin.inject, [
    'slots',
    'locale',
    'sessions',
    'conversation',
    'uiConversation',
    'uiWorkspace',
    'workspaces',
  ])

  const h = makeHarness()
  assert.deepEqual(h.registeredLocales.get(namespace), labels)
  assert.deepEqual([...h.slots.keys()].sort(), [
    'conversation.chat.user.before',
    'conversation.input.right',
    'shell.overlay',
  ])

  const rowEntry = h.slots.get('conversation.chat.user.before')
  assert.equal(rowEntry.options.priority, 100)
  assert.equal(rowEntry.options.select({ kind: 'user' }), true)
  assert.equal(rowEntry.options.select({ kind: 'steering' }), null)
  assert.equal(rowEntry.options.select({ kind: 'context' }), null)

  const inputEntry = h.slots.get('conversation.input.right')
  assert.equal(inputEntry.options.id, namespace)
  const withBinding = inputEntry.options.inject('s-1')
  assert.equal(withBinding.sessionInput.tag, 'source-ctx')
  const withoutBinding = inputEntry.options.inject('unknown-session')
  assert.equal(withoutBinding.sessionInput, undefined)

  // Check 8-locale runtime label keys + placeholders.
  const enKeys = Object.keys(labels.en).sort()
  assert.deepEqual(Object.keys(labels).sort(), Object.keys(LOCALE_TITLES))
  for (const [localeCode, dict] of Object.entries(labels)) {
    assert.deepEqual(Object.keys(dict).sort(), enKeys, `${localeCode} keys match en`)
    for (const key of enKeys) {
      assert.equal(typeof dict[key], 'string')
      assert.ok(dict[key].length > 0, `${localeCode}.${key} non-empty`)
      assert.deepEqual(placeholders(dict[key]), placeholders(labels.en[key]), `${localeCode}.${key} placeholders`)
    }
  }

  // Check 8 locale/*.json manifest files keep localized branding intact.
  const localeDir = new URL('../locale/', import.meta.url)
  const files = readdirSync(localeDir).sort()
  assert.deepEqual(files, Object.keys(LOCALE_TITLES).map(k => `${k}.json`))
  for (const file of files) {
    const code = file.replace('.json', '')
    const parsed = JSON.parse(readFileSync(new URL(file, localeDir), 'utf8'))
    assert.equal(parsed.meta.title, LOCALE_TITLES[code], `${file} preserves branding`)
  }

  // Verify the built client bundle replaced the old U-turn undo icon with the counter-clockwise circular arrow.
  const builtClient = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(builtClient, /M3\.1 11\.45A6 6 0 1 0 3\.5 4L2\.1 5\.6/)
  assert.doesNotMatch(builtClient, /M9 5 4 10l5 5/)

  h.dispose()
  assert.equal(h.slots.size, 0)
  assert.equal(h.registeredLocales.size, 0)
})

test('content helpers extract multimedia payloads, compute boundaries, and validate host payloads', () => {
  const payload = extractMessagePayload([
    { type: 'text', text: 'hello ' },
    { type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png' } },
    { type: 'file', attachment: { attachmentId: 'file-1', name: 'spec.pdf', bytes: 20 } },
    { type: 'text', text: 'world' },
  ])
  assert.equal(payload.text, 'hello world')
  assert.deepEqual(payload.attachments, [
    { kind: 'image', index: 1, ref: { attachmentId: 'img-1', mediaType: 'image/png' } },
    { kind: 'file', index: 2, ref: { attachmentId: 'file-1', name: 'spec.pdf', bytes: 20 } },
  ])
  assert.equal(fallbackImageName('image/png', 1), 'image-1.png')
  assert.equal(fallbackImageName('image/jpeg', 2), 'image-2.jpg')
  assert.equal(fallbackImageName('application/x-unknown', 3), 'image-3.bin')

  const n1 = userNode({ turn: 1, seq: 3, content: [] })
  const n2 = userNode({ turn: 2, seq: 8, content: [] })
  assert.equal(isUserChatNode(n2), true)
  assert.equal(isUserChatNode({ kind: 'steering', data: { seq: 8, content: [] } }), false)
  assert.equal(turnOf(n2), 2)
  assert.deepEqual(clientRewindBoundary({ timeline: { turns: new Map() } }, n1), { kind: 'create' })
  assert.deepEqual(clientRewindBoundary({ timeline: { turns: new Map([[1, { end: { seq: 6 } }]]) } }, n2), {
    kind: 'fork',
    atSeq: 6,
  })
  assert.equal(clientRewindBoundary({ timeline: { turns: new Map() } }, n2), undefined)

  assert.equal(hasNonTurnActivity([{ kind: 'turn' }]), false)
  assert.equal(hasNonTurnActivity([{ kind: 'turn' }, { kind: 'subagent', items: [{ id: 'a' }] }]), true)

  const archiveErr = Object.assign(new Error('active'), {
    name: 'WorkspaceArchiveError',
    rpcError: { code: 'workspace/session-active', details: { activity: [{ kind: 'turn' }] } },
  })
  assert.deepEqual(activeSessionRefusal(archiveErr), [{ kind: 'turn' }])
  assert.equal(activeSessionRefusal(new Error('other')), undefined)

  assert.deepEqual(
    parsePrepareResponse({ boundary: { kind: 'fork', atSeq: 5 }, activity: [] }),
    { boundary: { kind: 'fork', atSeq: 5 }, activity: [] },
  )
  assert.equal(parsePrepareResponse({ boundary: { kind: 'fork', atSeq: -1 }, activity: [] }), undefined)
  assert.equal(parsePrepareResponse({ boundary: { kind: 'create' } }), undefined)

  assert.deepEqual(
    inheritedInboxIds({
      projections: {
        faceOf: () => ({
          getSnapshot: () => ({
            'next-turn': [{ id: 'm1' }, { id: 'm2' }],
            'next-step': [{ id: 'm2' }, { id: 'm3' }, { id: '' }],
          }),
        }),
      },
    }),
    ['m1', 'm2', 'm3'],
  )
})

test('Turn > 1 happy path forks cleanly, restores text+multimedia, clears inbox, preserves pin/position, and switches before archiving', async () => {
  const fileBytes = new TextEncoder().encode('hello attachment')
  const h = makeHarness({
    workspacesState: {
      items: [{ workspaceId: 'ws-1', path: '/repo', sessionIds: ['s-1'] }],
      pinnedSessionIds: ['s-1'],
      archivedSessionIds: [],
    },
    inbox: {
      'next-turn': [{ id: 'queued-1' }],
      'next-step': [{ id: 'queued-2' }],
    },
    async readAttachmentImpl(ref) {
      assert.equal(ref.attachmentId, 'img-1')
      return {
        ok: true,
        value: {
          data: new Uint8Array([1, 2, 3]).buffer,
          attachment: { attachmentId: 'img-1', mediaType: 'image/png', name: undefined },
        },
      }
    },
    async fetchImpl(url) {
      if (url.includes('/api/dsh-session-rewind/prepare')) {
        return Response.json({ boundary: { kind: 'fork', atSeq: 8 }, activity: [] })
      }
      if (url.includes('/api/dsh-session-rewind/file')) {
        assert.match(url, /sessionId=s-1/)
        assert.match(url, /seq=10/)
        assert.match(url, /index=2/)
        assert.match(url, /attachmentId=file-1/)
        return new Response(fileBytes, { status: 200 })
      }
      return new Response('unexpected', { status: 500 })
    },
  })

  const node = userNode({
    turn: 2,
    seq: 10,
    content: [
      { type: 'text', text: 'Rewind me' },
      { type: 'image', attachment: { attachmentId: 'img-1', mediaType: 'image/png' } },
      { type: 'file', attachment: { attachmentId: 'file-1', name: 'notes.txt', bytes: fileBytes.byteLength } },
    ],
  })

  await h.controller.requestRewind('s-1', node)

  const forkCall = h.calls.find(c => c[0] === 'fork')
  assert.deepEqual(forkCall[1], { sessionId: 's-1', atSeq: 8, increaseTitle: false })
  assert.deepEqual(h.removedQueueItems.map(r => r[0]), ['queued-1', 'queued-2'])
  assert.deepEqual(h.draftInitCalls, [{ prompt: 'Rewind me', whenDraftExists: 'replace' }])

  // Ordering invariants: pin before insertSessionBefore, open inside using, open before archive.
  const pinIdx = h.calls.findIndex(c => c[0] === 'pinSession')
  const insertIdx = h.calls.findIndex(c => c[0] === 'insertSessionBefore')
  const openIdx = h.calls.findIndex(c => c[0] === 'openSession')
  const exitIdx = h.calls.findIndex(c => c[0] === 'using.exit')
  const archiveIdx = h.calls.findIndex(c => c[0] === 'archiveSession')
  assert.ok(pinIdx !== -1 && pinIdx < insertIdx, 'pins child before insertSessionBefore')
  assert.ok(openIdx !== -1 && openIdx < exitIdx, 'opens child inside retained using scope')
  assert.ok(openIdx < archiveIdx, 'opens child strictly before archiving source')
  assert.deepEqual(h.calls[openIdx], ['openSession', 's-fork', true])
  assert.deepEqual(h.calls[archiveIdx], ['archiveSession', 's-1', undefined])

  const restored = h.controller.takePendingFiles('s-fork')
  assert.equal(restored.length, 2)
  assert.equal(restored[0].name, 'image-1.png')
  assert.equal(restored[0].type, 'image/png')
  assert.equal(restored[1].name, 'notes.txt')
  assert.equal(restored[1].type, 'application/octet-stream')
  assert.equal(await restored[1].text(), 'hello attachment')

  const snap = h.controller.getSnapshot()
  assert.equal(snap.busySessionId, null)
  assert.deepEqual(snap.toast, {
    seq: 1,
    tone: 'success',
    kind: 'rewound',
    unarchive: { sessionId: 's-1', wasPinned: true },
  })

  const overlayToast = h.renderOverlay()
  assert.equal(overlayToast.props.children[0].type, 'Toast')
  assert.equal(overlayToast.props.children[0].props.actions[0].label, 'Unarchive original')
  assert.equal(overlayToast.props.children[1], false)

  // Unarchive one-click restores pin and reopens original session.
  await h.controller.unarchiveOriginal('s-1', true)
  const unarchiveCall = h.calls.slice(archiveIdx + 1)
  assert.deepEqual(unarchiveCall, [
    ['unarchiveSession', 's-1'],
    ['pinSession', 's-1'],
    ['openSession', 's-1', false],
  ])
  h.dispose()
})

test('Turn 1 attachment-only creates a fresh session without sessionId and falls back on unknown preset', async () => {
  let createAttempt = 0
  const h = makeHarness({
    async readAttachmentImpl(ref) {
      return {
        ok: true,
        value: {
          data: new Uint8Array([9, 8]).buffer,
          attachment: { attachmentId: ref.attachmentId, mediaType: 'image/png', name: 'clip.png' },
        },
      }
    },
    async createImpl() {
      createAttempt += 1
      if (createAttempt === 1) {
        throw Object.assign(new Error('missing preset'), {
          name: 'SessionCreateError',
          rpcError: { code: 'agent-preset/not-found', message: 'not found' },
        })
      }
      return 's-fresh'
    },
    async fetchImpl() {
      return Response.json({ boundary: { kind: 'create' }, activity: [] })
    },
  })

  const node = userNode({
    turn: 1,
    seq: 2,
    content: [{ type: 'image', attachment: { attachmentId: 'img-only', mediaType: 'image/png', name: 'clip.png' } }],
  })
  await h.controller.requestRewind('s-1', node)

  const creates = h.calls.filter(c => c[0] === 'create').map(c => c[1])
  assert.deepEqual(creates, [
    { workspaceId: 'ws-1', agentPreset: 'coder' },
    { workspaceId: 'ws-1' },
  ])
  assert.equal(h.draftInitCalls.length, 0, 'attachment-only skips prompt draft initialization')
  assert.equal(h.controller.peekPendingFiles('s-fresh')[0].name, 'clip.png')
  assert.equal(h.controller.getSnapshot().toast.kind, 'rewound')
  h.dispose()
})

test('running turn only rewinds immediately with stopActivity, while non-turn activity confirms before forking', async () => {
  // Turn-only active: no confirmation modal, passes stopActivity: true.
  const turnOnly = makeHarness({
    async fetchImpl() {
      return Response.json({ boundary: { kind: 'fork', atSeq: 5 }, activity: [{ kind: 'turn' }] })
    },
  })
  await turnOnly.controller.requestRewind('s-1', userNode({ turn: 2, seq: 7, content: [{ type: 'text', text: 'hi' }] }))
  assert.equal(turnOnly.controller.getSnapshot().confirm, null)
  assert.deepEqual(turnOnly.calls.find(c => c[0] === 'archiveSession'), ['archiveSession', 's-1', { stopActivity: true }])
  turnOnly.dispose()

  // Non-turn active: pauses before fork; cancel leaves zero forks; confirm executes with stopActivity.
  const withSubagent = makeHarness({
    async fetchImpl() {
      return Response.json({
        boundary: { kind: 'fork', atSeq: 5 },
        activity: [{ kind: 'subagent', items: [{ id: 'sub-1', label: 'Researcher' }] }],
      })
    },
  })
  await withSubagent.controller.requestRewind('s-1', userNode({ turn: 2, seq: 7, content: [{ type: 'text', text: 'wait' }] }))
  assert.equal(withSubagent.calls.some(c => c[0] === 'fork'), false, 'no fork while awaiting confirmation')
  const confirmSnap = withSubagent.controller.getSnapshot().confirm
  assert.equal(confirmSnap.mode, 'rewind')
  assert.equal(confirmSnap.displayTitle, 'Original Chat')

  const overlayBefore = withSubagent.renderOverlay()
  assert.equal(overlayBefore.props.children[0], false)
  assert.equal(overlayBefore.props.children[1].type, 'Modal')
  assert.equal(overlayBefore.props.children[1].props.tone, 'warning')

  withSubagent.controller.cancelConfirm()
  assert.equal(withSubagent.controller.getSnapshot().confirm, null)
  assert.equal(withSubagent.calls.some(c => c[0] === 'fork'), false)

  await withSubagent.controller.requestRewind('s-1', userNode({ turn: 2, seq: 7, content: [{ type: 'text', text: 'go' }] }))
  await withSubagent.controller.confirmAndProceed()
  assert.equal(withSubagent.controller.getSnapshot().confirm, null)
  assert.equal(withSubagent.calls.some(c => c[0] === 'fork'), true)
  assert.deepEqual(withSubagent.calls.find(c => c[0] === 'archiveSession'), ['archiveSession', 's-1', { stopActivity: true }])
  withSubagent.dispose()
})

test('host unavailable falls back to loadOlder + client boundary and handles archive refusal fallback', async () => {
  let archiveCalls = 0
  const h = makeHarness({
    turns: new Map(),
    olderPages: [new Map([[1, { end: { seq: 5 } }]])],
    async fetchImpl() {
      return new Response('nope', { status: 404 })
    },
    async archiveImpl(_id, opts) {
      archiveCalls += 1
      if (archiveCalls === 1 && opts === undefined) {
        throw Object.assign(new Error('active subagent'), {
          name: 'WorkspaceArchiveError',
          rpcError: {
            code: 'workspace/session-active',
            details: { activity: [{ kind: 'job', items: [{ id: 'j-1', label: 'Build' }] }] },
          },
        })
      }
    },
  })

  await h.controller.requestRewind('s-1', userNode({ turn: 2, seq: 7, content: [{ type: 'text', text: 'fallback' }] }))
  assert.equal(h.calls.some(c => c[0] === 'loadOlder'), true)
  assert.equal(h.calls.some(c => c[0] === 'fork' && c[1].atSeq === 5), true)
  assert.equal(h.controller.getSnapshot().confirm.mode, 'archive-only')

  await h.controller.confirmAndProceed()
  assert.equal(h.controller.getSnapshot().confirm, null)
  assert.equal(h.controller.getSnapshot().toast.kind, 'rewound')
  h.dispose()
})

test('handles attachment failures, fork/archive failures, unarchive failures, and busy re-entrancy safely', async () => {
  const partial = makeHarness({
    async readAttachmentImpl(ref) {
      if (ref.attachmentId === 'img-ok') {
        return {
          ok: true,
          value: {
            data: new Uint8Array([1]).buffer,
            attachment: { attachmentId: 'img-ok', mediaType: 'image/png', name: 'ok.png' },
          },
        }
      }
      return { ok: false }
    },
    async fetchImpl(url) {
      if (url.includes('/prepare')) return Response.json({ boundary: { kind: 'fork', atSeq: 5 }, activity: [] })
      return new Response('missing', { status: 404 })
    },
  })
  await partial.controller.requestRewind('s-1', userNode({
    turn: 2,
    seq: 7,
    content: [
      { type: 'image', attachment: { attachmentId: 'img-ok', mediaType: 'image/png' } },
      { type: 'file', attachment: { attachmentId: 'file-missing', name: 'lost.bin', bytes: 5 } },
    ],
  }))
  assert.equal(partial.controller.getSnapshot().toast.kind, 'rewoundPartialAttachments')
  assert.equal(partial.controller.getSnapshot().toast.count, 1)
  assert.equal(partial.controller.getSnapshot().toast.tone, 'warning')
  partial.dispose()

  const totalAttFail = makeHarness({
    async readAttachmentImpl() { return { ok: false } },
    async fetchImpl() { return Response.json({ boundary: { kind: 'create' }, activity: [] }) },
  })
  await totalAttFail.controller.requestRewind('s-1', userNode({
    turn: 1,
    seq: 2,
    content: [{ type: 'image', attachment: { attachmentId: 'img-bad', mediaType: 'image/png' } }],
  }))
  assert.equal(totalAttFail.controller.getSnapshot().toast.kind, 'rewoundNoAttachments')
  totalAttFail.dispose()

  // Fork failure must not switch or archive, and unarchive failure shows warning toast.
  let releaseFork
  const forkGate = new Promise(resolve => { releaseFork = resolve })
  const errors = makeHarness({
    async fetchImpl() { return Response.json({ boundary: { kind: 'fork', atSeq: 5 }, activity: [] }) },
    async forkImpl() {
      await forkGate
      throw new Error('fork exploded')
    },
    async unarchiveImpl() { throw new Error('unarchive denied') },
  })
  const firstRun = errors.controller.requestRewind('s-1', userNode({ turn: 2, seq: 7, content: [{ type: 'text', text: 'x' }] }))
  const concurrentRun = errors.controller.requestRewind('s-1', userNode({ turn: 2, seq: 7, content: [{ type: 'text', text: 'y' }] }))
  releaseFork()
  await Promise.all([firstRun, concurrentRun])
  assert.equal(errors.calls.filter(c => c[0] === 'fork').length, 1, 'ignores concurrent request while busy')
  assert.equal(errors.calls.some(c => c[0] === 'openSession'), false)
  assert.equal(errors.calls.some(c => c[0] === 'archiveSession'), false)
  assert.equal(errors.controller.getSnapshot().toast.kind, 'rewindFailed')

  await errors.controller.unarchiveOriginal('s-1', false)
  assert.equal(errors.controller.getSnapshot().toast.kind, 'unarchiveFailed')
  errors.dispose()

  // Archive failure after switch reports archiveFailed while keeping child open.
  const archiveErrHarness = makeHarness({
    async fetchImpl() { return Response.json({ boundary: { kind: 'fork', atSeq: 5 }, activity: [] }) },
    async archiveImpl() { throw new Error('disk full') },
  })
  await archiveErrHarness.controller.requestRewind('s-1', userNode({ turn: 2, seq: 7, content: [{ type: 'text', text: 'z' }] }))
  assert.equal(archiveErrHarness.calls.some(c => c[0] === 'openSession'), true)
  assert.equal(archiveErrHarness.controller.getSnapshot().toast.kind, 'archiveFailed')
  archiveErrHarness.dispose()
})
