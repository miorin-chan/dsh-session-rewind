import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject } from '../index.js'
import {
  createRewindHostHandlers,
  FILE_PATH,
  locateUserFileAttachment,
  PREPARE_PATH,
  resolveRewindBoundary,
} from '../lib/rewind-host.js'

function userMsg(seq, {
  source = { kind: 'user' },
  surfaceOp,
  content = [{ type: 'text', text: `msg-${seq}` }],
} = {}) {
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
    data: {
      id: `m-${seq}`,
      source,
      content,
    },
  }
}

function makeTurnEvents({ withPostTurnMetadata = false } = {}) {
  const events = [
    { type: 'session/title', seq: 0, time: 1000, data: { title: 'Initial', source: { kind: 'fallback' }, messageSeqs: [] } },
    { type: 'turn/start', seq: 1, time: 1001, data: { turn: 1 } },
    { type: 'agent/inbox/spliced', seq: 2, time: 1002, data: { target: 'next-turn' } },
    userMsg(3, {
      content: [
        { type: 'text', text: 'first turn' },
        { type: 'file', attachment: { attachmentId: 'att-file-1', name: 'notes.txt', bytes: 12 } },
      ],
    }),
    { type: 'assistant/message', seq: 4, time: 1004, data: { turn: 1, step: 1, message: { content: [] }, stream: [] } },
    { type: 'turn/end', seq: 5, time: 1005, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  if (withPostTurnMetadata) {
    events.push(
      { type: 'session/title', seq: 6, time: 1006, data: { title: 'Auto Title', source: { kind: 'fallback' }, messageSeqs: [3] } },
      { type: 'session/model-selected', seq: 7, time: 1007, data: { provider: 'deepseek', model: 'deepseek-chat' } },
      { type: 'compaction/summary', seq: 8, time: 1008, data: { summary: 'compact' } },
      { type: 'agent/inbox/spliced', seq: 9, time: 1009, data: { target: 'next-turn' } },
      { type: 'turn/start', seq: 10, time: 1010, data: { turn: 2 } },
      userMsg(11, {
        content: [
          { type: 'image', attachment: { attachmentId: 'att-img-2', mediaType: 'image/png', name: 'pic.png' } },
          { type: 'text', text: 'second turn' },
          { type: 'file', attachment: { attachmentId: 'att-file-2', name: 'data.bin', bytes: 7 } },
        ],
      }),
    )
  } else {
    events.push(
      { type: 'turn/start', seq: 6, time: 1006, data: { turn: 2 } },
      userMsg(7, { content: [{ type: 'text', text: 'second turn' }] }),
    )
  }
  return events
}

test('resolveRewindBoundary returns create for Turn 1 and fork boundary for Turn 2+', () => {
  const simple = makeTurnEvents({ withPostTurnMetadata: false })
  assert.deepEqual(resolveRewindBoundary(simple, 3), { kind: 'create' })
  assert.deepEqual(resolveRewindBoundary(simple, 7), { kind: 'fork', atSeq: 5 })

  const withMeta = makeTurnEvents({ withPostTurnMetadata: true })
  assert.deepEqual(resolveRewindBoundary(withMeta, 3), { kind: 'create' })
  // Preserves standalone metadata events (seq 6, 7, 8) and stops strictly before agent/inbox/spliced (seq 9).
  assert.deepEqual(resolveRewindBoundary(withMeta, 11), { kind: 'fork', atSeq: 8 })
})

test('resolveRewindBoundary rejects invalid sequences, non-user messages, and non-append surfaceOps', () => {
  const events = [
    ...makeTurnEvents({ withPostTurnMetadata: false }),
    userMsg(8, { source: { kind: 'system' } }),
    userMsg(9, { surfaceOp: 'replace' }),
  ]
  assert.equal(resolveRewindBoundary(events, -1), undefined)
  assert.equal(resolveRewindBoundary(events, 1.5), undefined)
  assert.equal(resolveRewindBoundary(events, 999), undefined)
  assert.equal(resolveRewindBoundary(events, 4), undefined)
  assert.equal(resolveRewindBoundary(events, 5), undefined)
  assert.equal(resolveRewindBoundary(events, 8), undefined)
  assert.equal(resolveRewindBoundary(events, 9), undefined)
})

test('locateUserFileAttachment validates seq, part index, kind, and attachmentId', () => {
  const events = makeTurnEvents({ withPostTurnMetadata: true })
  const ref = locateUserFileAttachment(events, 11, 2, 'att-file-2')
  assert.deepEqual(ref, { attachmentId: 'att-file-2', name: 'data.bin', bytes: 7 })

  assert.equal(locateUserFileAttachment(events, 11, 0, 'att-img-2'), undefined)
  assert.equal(locateUserFileAttachment(events, 11, 1, 'att-file-2'), undefined)
  assert.equal(locateUserFileAttachment(events, 11, 2, 'wrong-id'), undefined)
  assert.equal(locateUserFileAttachment(events, 4, 0, 'att-file-2'), undefined)
  assert.equal(locateUserFileAttachment(events, -1, 2, 'att-file-2'), undefined)
  assert.equal(locateUserFileAttachment(events, 11, -1, 'att-file-2'), undefined)
  assert.equal(locateUserFileAttachment(events, 11, 2, ''), undefined)
})

test('createRewindHostHandlers serves /prepare with cache-control and handles errors', async () => {
  const events = makeTurnEvents({ withPostTurnMetadata: true })
  let disposed = 0
  const ac = new AbortController()
  const handlers = createRewindHostHandlers({
    sessionQuery: {
      async observeSession(sessionId, options) {
        if (options?.signal?.aborted) {
          throw Object.assign(new Error('Aborted'), { code: 'ABORTED' })
        }
        if (sessionId === 'missing') {
          throw Object.assign(new Error('Missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        }
        assert.equal(options?.projectionMode, 'none')
        return {
          events,
          [Symbol.dispose]() { disposed += 1 },
        }
      },
    },
    attachments: { async *readFileStream() {} },
    queryActivity: async sessionId => (sessionId === 's1' ? [{ kind: 'turn' }] : []),
    signal: ac.signal,
  })

  assert.equal((await handlers.handlePrepare(new Request(`http://localhost${PREPARE_PATH}?seq=3`))).status, 400)
  assert.equal((await handlers.handlePrepare(new Request(`http://localhost${PREPARE_PATH}?sessionId=%20bad%20&seq=3`))).status, 400)
  assert.equal((await handlers.handlePrepare(new Request(`http://localhost${PREPARE_PATH}?sessionId=s1&seq=-2`))).status, 400)
  assert.equal((await handlers.handlePrepare(new Request(`http://localhost${PREPARE_PATH}?sessionId=missing&seq=3`))).status, 404)
  assert.equal((await handlers.handlePrepare(new Request(`http://localhost${PREPARE_PATH}?sessionId=s1&seq=4`))).status, 404)

  const okRes = await handlers.handlePrepare(new Request(`http://localhost${PREPARE_PATH}?sessionId=s1&seq=11`))
  assert.equal(okRes.status, 200)
  assert.equal(okRes.headers.get('Cache-Control'), 'private, no-store')
  assert.deepEqual(await okRes.json(), {
    boundary: { kind: 'fork', atSeq: 8 },
    activity: [{ kind: 'turn' }],
  })
  assert.equal(disposed, 2)

  ac.abort()
  const abortedRes = await handlers.handlePrepare(new Request(`http://localhost${PREPARE_PATH}?sessionId=s1&seq=11`))
  assert.equal(abortedRes.status, 503)
})

test('createRewindHostHandlers streams /file bytes, headers, and handles stream failures cleanly', async () => {
  const events = makeTurnEvents({ withPostTurnMetadata: true })
  let disposed = 0
  let streamMode = 'ok'
  let iteratorReturned = 0

  const handlers = createRewindHostHandlers({
    sessionQuery: {
      async observeSession(sessionId) {
        if (sessionId === 'missing') {
          throw Object.assign(new Error('Missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        }
        return {
          events,
          [Symbol.dispose]() { disposed += 1 },
        }
      },
    },
    attachments: {
      readFileStream() {
        return {
          [Symbol.asyncIterator]() {
            let step = 0
            return {
              async next() {
                if (streamMode === 'first-missing') {
                  throw Object.assign(new Error('Not found'), { code: 'ATTACHMENT_NOT_FOUND' })
                }
                if (streamMode === 'unsupported') {
                  throw Object.assign(new Error('Unsupported'), { code: 'ATTACHMENT_FILES_UNSUPPORTED' })
                }
                if (streamMode === 'mid-fail' && step === 1) {
                  throw new Error('Disk read failure')
                }
                step += 1
                if (step === 1) return { done: false, value: new Uint8Array([100, 97, 116]) }
                if (step === 2) return { done: false, value: new Uint8Array([97, 45, 52, 50]) }
                return { done: true, value: undefined }
              },
              async return() {
                iteratorReturned += 1
                return { done: true, value: undefined }
              },
            }
          },
        }
      },
    },
    queryActivity: async () => [],
    signal: new AbortController().signal,
  })

  assert.equal((await handlers.handleFile(new Request(`http://localhost${FILE_PATH}?sessionId=s1`))).status, 400)
  assert.equal((await handlers.handleFile(new Request(`http://localhost${FILE_PATH}?sessionId=missing&seq=11&index=2&attachmentId=att-file-2`))).status, 404)
  assert.equal((await handlers.handleFile(new Request(`http://localhost${FILE_PATH}?sessionId=s1&seq=11&index=0&attachmentId=att-img-2`))).status, 404)

  const okRes = await handlers.handleFile(new Request(`http://localhost${FILE_PATH}?sessionId=s1&seq=11&index=2&attachmentId=att-file-2`))
  assert.equal(okRes.status, 200)
  assert.equal(okRes.headers.get('Content-Type'), 'application/octet-stream')
  assert.equal(okRes.headers.get('Content-Length'), '7')
  assert.equal(okRes.headers.get('Cache-Control'), 'private, no-store')
  assert.equal(okRes.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(await okRes.text(), 'data-42')

  streamMode = 'first-missing'
  assert.equal((await handlers.handleFile(new Request(`http://localhost${FILE_PATH}?sessionId=s1&seq=11&index=2&attachmentId=att-file-2`))).status, 404)

  streamMode = 'unsupported'
  assert.equal((await handlers.handleFile(new Request(`http://localhost${FILE_PATH}?sessionId=s1&seq=11&index=2&attachmentId=att-file-2`))).status, 501)

  streamMode = 'mid-fail'
  const midFailRes = await handlers.handleFile(new Request(`http://localhost${FILE_PATH}?sessionId=s1&seq=11&index=2&attachmentId=att-file-2`))
  assert.equal(midFailRes.status, 200)
  await assert.rejects(midFailRes.arrayBuffer(), /Disk read failure/)
  assert.ok(iteratorReturned >= 3, 'iterator.return() was called on errors')
  assert.equal(disposed, 5)
})

test('host apply registers both GET routes, queries activity waterfall, and disposes cleanly', async () => {
  assert.deepEqual(inject, ['connection', 'attachments', 'sessionQuery'])
  const routes = new Map()
  const disposers = []
  let observedSignal
  let waterfallPayload

  apply({
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return () => { routes.delete(route.path) }
        },
      },
    },
    attachments: { async *readFileStream() {} },
    sessionQuery: {
      async observeSession(_sessionId, options) {
        observedSignal = options?.signal
        return {
          events: makeTurnEvents({ withPostTurnMetadata: false }),
          [Symbol.dispose]() {},
        }
      },
    },
    async waterfall(event, payload) {
      assert.equal(event, 'workspace/session-activity')
      waterfallPayload = payload
      return [{ kind: 'subagent', items: [{ id: 'sub-1', label: 'Worker' }] }]
    },
  })

  assert.deepEqual([...routes.keys()], [PREPARE_PATH, FILE_PATH])
  assert.deepEqual(routes.get(PREPARE_PATH).methods, ['GET'])
  assert.deepEqual(routes.get(FILE_PATH).methods, ['GET'])

  const res = await routes.get(PREPARE_PATH).fetch(new Request(`http://localhost${PREPARE_PATH}?sessionId=s1&seq=7`))
  assert.equal(res.status, 200)
  assert.deepEqual(waterfallPayload, { sessionId: 's1' })
  assert.deepEqual(await res.json(), {
    boundary: { kind: 'fork', atSeq: 5 },
    activity: [{ kind: 'subagent', items: [{ id: 'sub-1', label: 'Worker' }] }],
  })
  assert.equal(observedSignal.aborted, false)

  for (const dispose of disposers.reverse()) dispose()
  assert.equal(routes.size, 0)
  assert.equal(observedSignal.aborted, true)
})
