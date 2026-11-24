import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionObservation, SessionObservationOptions } from '@deepseek-ai/dsh-session-query'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'

export const PREPARE_PATH = '/api/dsh-undo-unsent/prepare'
export const FILE_PATH = '/api/dsh-undo-unsent/file'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' } as const
const FILE_HEADERS = {
  'Content-Type': 'application/octet-stream',
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
} as const

export type RewindBoundary =
  | { readonly kind: 'create' }
  | { readonly kind: 'fork'; readonly atSeq: number }

export interface RewindHostDeps {
  readonly sessionQuery: {
    observeSession(sessionId: SessionId, options?: SessionObservationOptions): Promise<SessionObservation>
  }
  readonly attachments: Pick<AttachmentStore, 'readFileStream'>
  readonly queryActivity: (sessionId: SessionId) => Promise<readonly SessionActivity[]>
  readonly signal: AbortSignal
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function parseSessionId(url: URL): SessionId | undefined {
  const raw = url.searchParams.get('sessionId')
  if (raw === null || raw.length === 0 || raw !== raw.trim() || raw.includes('\0')) return undefined
  return raw as SessionId
}

function parseNonNegativeInt(raw: string | null): number | undefined {
  if (raw === null || !/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function findEventIndex(events: readonly SessionEvent[], seq: number): number {
  if (seq >= 0 && seq < events.length && events[seq]?.seq === seq) return seq
  return events.findIndex(event => event.seq === seq)
}

/**
 * Resolve the fork or fresh-create boundary immediately preceding an ordinary
 * user message at `messageSeq`.
 */
export function resolveRewindBoundary(
  events: readonly SessionEvent[],
  messageSeq: number,
): RewindBoundary | undefined {
  if (!Number.isSafeInteger(messageSeq) || messageSeq < 0) return undefined
  const targetIndex = findEventIndex(events, messageSeq)
  if (targetIndex < 0) return undefined
  const target = events[targetIndex]
  if (
    target === undefined
    || target.type !== 'user/message'
    || target.data.source.kind !== 'user'
    || (target.surfaceOp !== undefined && target.surfaceOp !== 'append')
  ) {
    return undefined
  }

  let turnStartIndex: number | undefined
  for (let index = targetIndex - 1; index >= 0; index--) {
    const candidate = events[index]
    if (candidate === undefined) continue
    if (candidate.type === 'turn/start') {
      turnStartIndex = index
      break
    }
    if (candidate.type === 'turn/end') break
  }

  const searchLimit = turnStartIndex ?? targetIndex
  let prevTurnEndIndex: number | undefined
  for (let index = searchLimit - 1; index >= 0; index--) {
    if (events[index]?.type === 'turn/end') {
      prevTurnEndIndex = index
      break
    }
  }
  if (prevTurnEndIndex === undefined) return { kind: 'create' }

  let boundary = events[prevTurnEndIndex]!.seq
  for (let index = prevTurnEndIndex + 1; index < searchLimit; index++) {
    const next = events[index]
    if (next === undefined) continue
    if (
      next.type === 'turn/start'
      || (next.type === 'user/message' && next.surfaceOp === 'append')
      || next.type === 'agent/inbox/spliced'
    ) {
      break
    }
    boundary = next.seq
  }
  return { kind: 'fork', atSeq: boundary }
}

/**
 * Verify that `attachmentId` belongs to a user message's `file` part at
 * `(messageSeq, index)` in `events` and return its durable reference.
 */
export function locateUserFileAttachment(
  events: readonly SessionEvent[],
  messageSeq: number,
  index: number,
  attachmentId: string,
): FileAttachmentRef | undefined {
  if (!Number.isSafeInteger(messageSeq) || messageSeq < 0) return undefined
  if (!Number.isSafeInteger(index) || index < 0) return undefined
  if (typeof attachmentId !== 'string' || attachmentId.length === 0) return undefined

  const targetIndex = findEventIndex(events, messageSeq)
  if (targetIndex < 0) return undefined
  const target = events[targetIndex]
  if (
    target === undefined
    || target.type !== 'user/message'
    || target.data.source.kind !== 'user'
    || (target.surfaceOp !== undefined && target.surfaceOp !== 'append')
  ) {
    return undefined
  }
  const part = target.data.content[index]
  if (part === undefined || part.type !== 'file') return undefined
  if (part.attachment.attachmentId !== attachmentId) return undefined
  return part.attachment
}

/** Build the Host GET route handlers for rewind preparation and file reads. */
export function createRewindHostHandlers(deps: RewindHostDeps) {
  async function observe(sessionId: SessionId, signal: AbortSignal): Promise<SessionObservation> {
    return deps.sessionQuery.observeSession(sessionId, { signal, projectionMode: 'none' })
  }

  async function handlePrepare(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const sessionId = parseSessionId(url)
    const seq = parseNonNegativeInt(url.searchParams.get('seq'))
    if (sessionId === undefined || seq === undefined) {
      return Response.json({ error: 'invalid-request' }, { status: 400, headers: NO_STORE_HEADERS })
    }
    const signal = AbortSignal.any([request.signal, deps.signal])
    try {
      let boundary: RewindBoundary | undefined
      const observation = await observe(sessionId, signal)
      try {
        boundary = resolveRewindBoundary(observation.events, seq)
      } finally {
        observation[Symbol.dispose]()
      }
      if (boundary === undefined) {
        return Response.json({ error: 'message-not-found' }, { status: 404, headers: NO_STORE_HEADERS })
      }
      const activity = await deps.queryActivity(sessionId)
      return Response.json({ boundary, activity }, { headers: NO_STORE_HEADERS })
    } catch (error: unknown) {
      if (signal.aborted) return new Response(null, { status: 503, headers: NO_STORE_HEADERS })
      if (errorCodeOf(error) === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        return Response.json({ error: 'session-not-found' }, { status: 404, headers: NO_STORE_HEADERS })
      }
      return Response.json({ error: 'prepare-unavailable' }, { status: 500, headers: NO_STORE_HEADERS })
    }
  }

  async function handleFile(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const sessionId = parseSessionId(url)
    const seq = parseNonNegativeInt(url.searchParams.get('seq'))
    const index = parseNonNegativeInt(url.searchParams.get('index'))
    const attachmentId = url.searchParams.get('attachmentId')
    if (
      sessionId === undefined
      || seq === undefined
      || index === undefined
      || attachmentId === null
      || attachmentId.length === 0
    ) {
      return Response.json({ error: 'invalid-request' }, { status: 400, headers: NO_STORE_HEADERS })
    }

    const signal = AbortSignal.any([request.signal, deps.signal])
    try {
      let ref: FileAttachmentRef | undefined
      const observation = await observe(sessionId, signal)
      try {
        ref = locateUserFileAttachment(observation.events, seq, index, attachmentId)
      } finally {
        observation[Symbol.dispose]()
      }
      if (ref === undefined) {
        return Response.json({ error: 'attachment-not-found' }, { status: 404, headers: NO_STORE_HEADERS })
      }

      const iterator = deps.attachments.readFileStream(ref, signal)[Symbol.asyncIterator]()
      let first: IteratorResult<Uint8Array>
      try {
        first = await iterator.next()
      } catch (error: unknown) {
        await iterator.return?.().catch(() => {})
        throw error
      }

      let pulledFirst = false
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!pulledFirst) {
            pulledFirst = true
            if (first.done) {
              controller.close()
              return
            }
            controller.enqueue(first.value)
            return
          }
          const next = await iterator.next().catch(async (error: unknown) => {
            await iterator.return?.().catch(() => {})
            throw error
          })
          if (next.done) {
            controller.close()
            return
          }
          controller.enqueue(next.value)
        },
        async cancel() {
          await iterator.return?.().catch(() => {})
        },
      })

      return new Response(body, {
        status: 200,
        headers: {
          ...FILE_HEADERS,
          'Content-Length': String(ref.bytes),
        },
      })
    } catch (error: unknown) {
      if (signal.aborted) return new Response(null, { status: 503, headers: NO_STORE_HEADERS })
      const code = errorCodeOf(error)
      if (code === 'SESSION_QUERY_SESSION_NOT_FOUND' || code === 'ATTACHMENT_NOT_FOUND') {
        return Response.json({ error: 'attachment-not-found' }, { status: 404, headers: NO_STORE_HEADERS })
      }
      if (code === 'ATTACHMENT_FILES_UNSUPPORTED') {
        return Response.json({ error: 'files-unsupported' }, { status: 501, headers: NO_STORE_HEADERS })
      }
      if (code === 'INVALID_ATTACHMENT_REF') {
        return Response.json({ error: 'invalid-attachment-ref' }, { status: 400, headers: NO_STORE_HEADERS })
      }
      return Response.json({ error: 'attachment-unavailable' }, { status: 500, headers: NO_STORE_HEADERS })
    }
  }

  return { handlePrepare, handleFile }
}
