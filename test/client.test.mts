import assert from 'node:assert/strict'
import test from 'node:test'

const namespace = 'dsh-undo-unsent'
const composerSlot = 'conversation.input.right'
const rowSlot = 'conversation.chat.user.before'
let registration

globalThis.window = { __ModuleLoader__: { load: entry => { registration = entry } } }
try {
  await import('../client.js')
} finally {
  delete globalThis.window
}

const plugin = registration.factory(() => ({}))
const messages = { undone: 'undone', restored: 'restored', unavailable: 'unavailable' }

function store(value) {
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

function fixture(remove = async () => ({ ok: true })) {
  const registrations = new Map()
  const effects = []
  const notices = []
  const removals = []
  const input = store({ phase: 'plain', draft: 'sent text', draftRev: 1 })
  const state = store({ running: false, pendingSubmissions: [] })
  const inbox = store(undefined)
  const turns = new Map()
  const nodes = []
  const steps = store([])
  const chat = store({
    timeline: { turnOrder: [1], turns },
    nodes: { values: () => nodes, turnDataSource: () => steps },
  })
  const binding = { sessionId: 'session-A', session: {
    ...state, projections: { faceOf: () => inbox }, updateQueue: (id, action) => {
      removals.push([id, action])
      return remove()
    },
  } }
  plugin.apply({
    effect: install => effects.push(install()),
    slots: {
      inject: (_name, install) => install(),
      register: (options, component) => {
        registrations.set(options.name, { options, component })
        return () => registrations.delete(options.name)
      },
    },
    locale: {
      register: (name, labels) => {
        registrations.set(name, labels)
        return () => registrations.delete(name)
      },
    },
    sessions: {
      binding: id => id === binding.sessionId ? binding : undefined,
      using: async (id, _options, use) => {
        assert.equal(id, binding.sessionId)
        return use({ binding })
      },
    },
    conversation: { input: {
      for: () => ({ state: input, notify: (level, text) => notices.push([level, text]) }),
      requestDraftInitialization(target, options) {
        assert.equal(target, binding)
        assert.equal(options.whenDraftExists, 'append')
        const snapshot = input.getSnapshot()
        const draft = snapshot.draft === '' ? options.prompt : `${snapshot.draft}\n${options.prompt}`
        input.set({ ...snapshot, draft, draftRev: snapshot.draftRev + 1 })
        return 'applied'
      },
    } },
    uiConversation: { binding: () => ({ target: () => chat }) },
  })
  const tracker = registrations.get(composerSlot).options.inject(binding.sessionId).tracker
  const unwatch = tracker.watch()
  function accept() {
    state.set({ running: true, pendingSubmissions: [{ requestId: 'request-A', placement: 'transcript' }] })
    input.set({ phase: 'plain', draft: '', draftRev: 2 })
  }
  return { registrations, binding, tracker, input, state, inbox, turns, nodes, steps, chat, notices, removals, accept,
    dispose: () => { unwatch(); effects.reverse().forEach(dispose => dispose()) } }
}

test('contributes undo through the composer and message decoration without shadowing the queue', () => {
  const f = fixture()
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'sessions', 'conversation', 'uiConversation'])
  assert.equal(registration.id, '@miorin/dsh-undo-unsent')
  assert.deepEqual([...f.registrations.keys()], [namespace, composerSlot, rowSlot])
  const { options } = f.registrations.get(rowSlot)
  assert.equal(Object.keys(f.registrations.get(namespace)).length, 8)
  assert.equal(options.inject(f.binding.sessionId).tracker, f.tracker)
  assert.deepEqual(options.inject('other-session'), {})
  assert.equal(options.select({ kind: 'user', source: { rpcId: 'request-A' } }), 'request-A')
  assert.equal(options.select({ kind: 'steering', source: { rpcId: 'request-A' } }), null)
  assert.equal(options.select({ kind: 'user', source: { rpcId: 42 } }), null)
  f.dispose()
  assert.equal(f.registrations.size, 0)
})

test('only visible text in the matching reply closes the direct-send window', () => {
  const f = fixture()
  f.input.set({ ...f.input.getSnapshot(), phase: 'sending' })
  assert.equal(f.tracker.active().draft, 'sent text')
  f.accept()
  f.turns.set(1, { status: 'closed' })
  f.nodes.push({ kind: 'user', location: { kind: 'turn', turn: { turn: 2 } }, data: { source: { rpcId: 'request-A' } } })
  f.chat.set(f.chat.getSnapshot())
  f.steps.set([{ blocks: [{ kind: 'reasoning', text: 'working' }] }])
  assert.equal(f.tracker.active().requestId, 'request-A')
  f.steps.set([{ blocks: [{ kind: 'text', text: 'reply' }] }])
  assert.equal(f.tracker.active(), undefined)
  f.dispose()
})

test('undo uses the exact Inbox occurrence, and restores once even if removal fails', async () => {
  const f = fixture(async () => ({ ok: false }))
  f.input.set({ ...f.input.getSnapshot(), phase: 'sending' })
  f.accept()
  f.input.set({ phase: 'plain', draft: 'new draft', draftRev: 3 })
  f.inbox.set({ 'next-turn': [
    { id: 'unrelated', role: 'user', source: { rpcId: 'request-B' } },
    { id: 'matching', role: 'user', source: { rpcId: 'request-A' } },
  ] })
  const target = f.tracker.active()
  await Promise.all([f.tracker.undo(target, true, messages), f.tracker.undo(target, true, messages)])
  assert.deepEqual(f.removals, [['matching', { kind: 'remove' }]])
  assert.equal(f.input.getSnapshot().draft, 'new draft\n\nsent text')
  assert.deepEqual(f.notices, [['info', 'restored']])
  f.dispose()
})

test('an early click withdraws the matching occurrence once it becomes available', async () => {
  const f = fixture()
  f.input.set({ ...f.input.getSnapshot(), phase: 'sending' })
  const undo = f.tracker.undo(f.tracker.active(), true, messages)
  f.inbox.set({ 'next-turn': [{ id: 'matching', role: 'user', source: { rpcId: 'request-A' } }] })
  f.accept()
  await undo
  assert.deepEqual(f.removals, [['matching', { kind: 'remove' }]])
  assert.equal(f.input.getSnapshot().draft, 'sent text')
  assert.deepEqual(f.notices, [['info', 'undone']])
  f.dispose()
})

test('a click before acceptance waits for the editor and preserves a rejected draft', async () => {
  const f = fixture()
  const original = f.input.getSnapshot()
  f.input.set({ ...original, phase: 'sending' })
  const undo = f.tracker.undo(f.tracker.active(), true, messages)
  f.input.set(original)
  await undo
  assert.equal(f.input.getSnapshot().draft, 'sent text')
  assert.deepEqual(f.removals, [])
  assert.deepEqual(f.notices, [['info', 'restored']])
  f.state.set({ running: true, pendingSubmissions: [] })
  f.input.set({ ...original, phase: 'sending' })
  assert.equal(f.tracker.active(), undefined)
  f.dispose()
})
