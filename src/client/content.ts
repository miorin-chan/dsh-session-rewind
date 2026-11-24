import type { FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionActivity, SessionActivityItem } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ChatConversationViewNode, ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'

export type RewindBoundary =
  | { readonly kind: 'create' }
  | { readonly kind: 'fork'; readonly atSeq: number }

export type MessageAttachment =
  | { readonly kind: 'image'; readonly index: number; readonly ref: ImageAttachmentRef }
  | { readonly kind: 'file'; readonly index: number; readonly ref: FileAttachmentRef }

export interface ExtractedMessagePayload {
  readonly text: string
  readonly attachments: readonly MessageAttachment[]
}

export interface RewindPrepareResponse {
  readonly boundary: RewindBoundary
  readonly activity: readonly SessionActivity[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isImageAttachmentRef(value: unknown): value is ImageAttachmentRef {
  return isRecord(value)
    && typeof value.attachmentId === 'string'
    && value.attachmentId !== ''
    && typeof value.mediaType === 'string'
}

function isFileAttachmentRef(value: unknown): value is FileAttachmentRef {
  return isRecord(value)
    && typeof value.attachmentId === 'string'
    && value.attachmentId !== ''
    && typeof value.name === 'string'
    && typeof value.bytes === 'number'
}

/** Extract ordered text and attachment references (with content indices) from a user message. */
export function extractMessagePayload(content: readonly ContentBlock[]): ExtractedMessagePayload {
  const texts: string[] = []
  const attachments: MessageAttachment[] = []
  for (let index = 0; index < content.length; index++) {
    const block = content[index] as { type?: unknown; text?: unknown; attachment?: unknown } | undefined
    if (block === undefined) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
    } else if (block.type === 'image' && isImageAttachmentRef(block.attachment)) {
      attachments.push({ kind: 'image', index, ref: block.attachment })
    } else if (block.type === 'file' && isFileAttachmentRef(block.attachment)) {
      attachments.push({ kind: 'file', index, ref: block.attachment })
    }
  }
  return { text: texts.join(''), attachments }
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** Synthesize a safe filename when an image attachment omitted `name`. */
export function fallbackImageName(mediaType: string, ordinal: number): string {
  const ext = IMAGE_EXTENSIONS[mediaType] ?? 'bin'
  return `image-${ordinal}.${ext}`
}

/** Narrow a generic Chat node to a persisted ordinary user message node. */
export function isUserChatNode(node: ChatConversationViewNode | undefined): node is ChatNode<'user'> {
  return node !== undefined
    && node.kind === 'user'
    && isRecord(node.data)
    && typeof node.data.seq === 'number'
    && Array.isArray(node.data.content)
}

/** Resolve the turn number owning a user message node. */
export function turnOf(node: ChatNode<'user'> | undefined): number | undefined {
  const location = node?.location
  return location?.kind === 'step' || location?.kind === 'turn' ? location.turn.turn : undefined
}

/**
 * Fallback client-side boundary computation when the Host prepare route is unavailable.
 */
export function clientRewindBoundary(
  chat: ChatSnapshot | undefined,
  node: ChatNode<'user'>,
): RewindBoundary | undefined {
  const turn = turnOf(node)
  if (turn === undefined) return undefined
  if (turn <= 1) return { kind: 'create' }
  const prevEnd = chat?.timeline.turns.get(turn - 1)?.end?.seq
  return prevEnd === undefined ? undefined : { kind: 'fork', atSeq: prevEnd }
}

/** Whether any reported session activity requires explicit stop confirmation before rewind. */
export function hasNonTurnActivity(activity: readonly SessionActivity[]): boolean {
  return activity.some(entry => entry.kind !== 'turn')
}

/**
 * Extract Host `workspace/session-activity` items from a `WorkspaceArchiveError`
 * without relying on cross-bundle class identity.
 */
export function activeSessionRefusal(error: unknown): readonly SessionActivity[] | undefined {
  if (!(error instanceof Error) || error.name !== 'WorkspaceArchiveError') return undefined
  if (!('rpcError' in error) || !isRecord(error.rpcError)) return undefined
  if (error.rpcError.code !== 'workspace/session-active') return undefined
  const details = error.rpcError.details
  if (!isRecord(details) || !Array.isArray(details.activity)) return undefined
  return parseActivityList(details.activity)
}

function parseActivityItem(value: unknown): SessionActivityItem | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined
  const label = value.label
  if (label !== undefined && typeof label !== 'string') return undefined
  return label === undefined
    ? { id: value.id }
    : { id: value.id, label }
}

function parseActivityList(value: unknown): readonly SessionActivity[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: SessionActivity[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.kind !== 'string') return undefined
    let items: SessionActivityItem[] | undefined
    if ('items' in entry && entry.items !== undefined) {
      if (!Array.isArray(entry.items)) return undefined
      items = []
      for (const rawItem of entry.items) {
        const parsed = parseActivityItem(rawItem)
        if (parsed === undefined) return undefined
        items.push(parsed)
      }
    }
    out.push(
      items === undefined
        ? { kind: entry.kind as SessionActivity['kind'] }
        : { kind: entry.kind as SessionActivity['kind'], items },
    )
  }
  return out
}

/** Validate and narrow JSON returned by `/api/dsh-undo-unsent/prepare`. */
export function parsePrepareResponse(value: unknown): RewindPrepareResponse | undefined {
  if (!isRecord(value) || !isRecord(value.boundary)) return undefined
  let boundary: RewindBoundary | undefined
  if (value.boundary.kind === 'create') {
    boundary = { kind: 'create' }
  } else if (
    value.boundary.kind === 'fork'
    && typeof value.boundary.atSeq === 'number'
    && Number.isSafeInteger(value.boundary.atSeq)
    && value.boundary.atSeq >= 0
  ) {
    boundary = { kind: 'fork', atSeq: value.boundary.atSeq }
  }
  if (boundary === undefined) return undefined
  const activity = parseActivityList(value.activity)
  if (activity === undefined) return undefined
  return { boundary, activity }
}

/** Collect all pending inbox occurrence IDs inherited on a session. */
export function inheritedInboxIds(session: SessionFace): readonly MessageId[] {
  const inbox = session.projections.faceOf('inbox').getSnapshot()
  if (!isRecord(inbox)) return []
  const ids = new Set<MessageId>()
  for (const target of ['next-turn', 'next-step'] as const) {
    const rows = inbox[target]
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      if (isRecord(row) && typeof row.id === 'string' && row.id !== '') {
        ids.add(row.id as MessageId)
      }
    }
  }
  return [...ids]
}
