import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { pendingRows, rowKey } from '../src/client/rows.ts'

const requireModule = createRequire(import.meta.url)
const namespace = 'dsh-undo-unsent'

await test('loaded artifact registers the queue slot and disposes it on unload', async () => {
  let registration
  globalThis.window = { __ModuleLoader__: { load: entry => { registration = entry } } }
  try {
    await import('../client.js')
  } finally {
    delete globalThis.window
  }
  assert.equal(registration.id, '@miorin/dsh-undo-unsent')
  const plugin = registration.factory(requireModule)
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'sessions', 'conversation', 'uiConversation'])

  const installed = new Map()
  const effects = []
  const sessions = { binding: () => undefined, scope: () => undefined }
  plugin.apply({
    effect: install => effects.push(install()),
    slots: {
      inject: (slot, install) => {
        assert.equal(slot, 'conversation.input.dock')
        return install()
      },
      register: (options, component) => {
        installed.set(options.id, { options, component })
        return () => installed.delete(options.id)
      },
    },
    locale: {
      register: (name, labels) => {
        installed.set(name, labels)
        return () => installed.delete(name)
      },
      bind: key => () => key,
    },
    sessions,
  })

  const { options, component } = installed.get('queue')
  assert.equal(options.order, 20)
  assert.equal(options.priority, -1)
  assert.equal(options.locale, namespace)
  assert.equal(typeof component, 'function')
  assert.equal(Object.keys(installed.get(namespace)).length, 8)

  const actions = options.inject('session-A')
  assert.equal(actions.getSession(), undefined)
  const scoped = { updateQueue() {} }
  sessions.binding = sessionId => sessionId === 'session-A' ? { session: scoped } : undefined
  assert.equal(actions.getSession(), scoped)
  assert.equal(options.inject('session-B').getSession(), undefined)

  effects.reverse().forEach(dispose => dispose())
  assert.equal(installed.size, 0)
})

const queued = (id, content, source = { kind: 'user' }) => ({ id, role: 'user', content, source })
const echo = (requestId, placement = 'queued') => ({ requestId, placement, time: 0, text: 'sending', attachments: [] })

await test('groups current messages by their host occurrence and avoids duplicate queue echoes', () => {
  const result = pendingRows({
    'next-turn': [queued('queued-1', [{ type: 'text', text: 'first' }], { kind: 'user', rpcId: 'r1' })],
    'next-step': [queued('steer-1', [{ type: 'text', text: 'second' }]), queued('internal', [], { kind: 'injection' })],
  }, [echo('r1'), echo('r2'), echo('r3', 'steering')])
  assert.deepEqual(result.map(rowKey), ['request:r1', 'message:steer-1', 'request:r2'])
  assert.deepEqual(result.map(row => [row.kind, row.id, row.target, row.content.text, row.editable]), [
    ['queued', 'queued-1', 'next-turn', 'first', true],
    ['queued', 'steer-1', 'next-step', 'second', false],
    ['sending', undefined, undefined, 'sending', undefined],
  ])
})

await test('preserves attachment order and prevents text edits on mixed content', () => {
  const reference = { attachmentId: 'photo', bytes: 2, mediaType: 'image/png', width: 1, height: 1 }
  const file = { attachmentId: 'report', name: 'report.txt', bytes: 4 }
  const [row] = pendingRows({
    'next-turn': [queued('with-files', [
      { type: 'image', attachment: reference }, { type: 'text', text: 'line one\nline two' },
      { type: 'file', attachment: file },
    ])],
    'next-step': [],
  }, [])
  assert.equal(row.editable, false)
  assert.deepEqual(row.content, {
    text: 'line one\nline two', attachments: [{ type: 'image', image: { attachment: reference } }, { type: 'file', file }],
    extraBlocks: [],
  })
})

await test('withholds withdrawal identity for local echoes and rejects malformed inbox rows', () => {
  const broken = pendingRows({
    'next-turn': [{ id: 42, role: 'user', content: [], source: { kind: 'user' } }, { id: 'unknown', role: 'assistant' }],
    'next-step': [null, queued('', [])],
  }, [echo('local-only')])
  assert.equal(broken.length, 1)
  assert.equal(broken[0].kind, 'sending')
  assert.equal('id' in broken[0], false)
  assert.deepEqual(pendingRows(undefined, [echo('transcript', 'transcript')]), [])
})
