import type { InboxTarget, InboxWireState } from '@deepseek-ai/dsh-agent/types'
import type { PendingSubmission } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AttachmentId, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { UserContentAttachment, UserContentData } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'

type QueuedRow = {
  readonly kind: 'queued'
  readonly id: MessageId
  readonly requestId?: string
  readonly target: InboxTarget
  readonly content: UserContentData
  readonly editable: boolean
}

type SendingRow = {
  readonly kind: 'sending'
  readonly requestId: string
  readonly content: UserContentData
}

export type PendingRow = QueuedRow | SendingRow

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mediaType(value: unknown): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

function imageRef(ref: Record<string, unknown>, attachmentId: AttachmentId, bytes: number): ImageAttachmentRef | undefined {
  if (!mediaType(ref.mediaType) || typeof ref.width !== 'number' || typeof ref.height !== 'number') return undefined
  return {
    attachmentId, mediaType: ref.mediaType, bytes, width: ref.width, height: ref.height,
    ...(typeof ref.name === 'string' ? { name: ref.name } : {}),
  }
}

function attachmentOf(block: Record<string, unknown>): UserContentAttachment | undefined {
  const ref = block.attachment
  if (!record(ref) || typeof ref.attachmentId !== 'string' || typeof ref.bytes !== 'number') return undefined
  const attachmentId = ref.attachmentId as AttachmentId
  if (block.type === 'file' && typeof ref.name === 'string') {
    return { type: 'file', file: { attachmentId, bytes: ref.bytes, name: ref.name } }
  }
  if (block.type === 'image') {
    const attachment = imageRef(ref, attachmentId, ref.bytes)
    if (attachment !== undefined) return { type: 'image', image: { attachment } }
  }
  return undefined
}

function queuedRow(message: unknown, target: InboxTarget): QueuedRow | undefined {
  if (!record(message) || message.role !== 'user' || typeof message.id !== 'string' || message.id === ''
    || !Array.isArray(message.content) || !record(message.source) || typeof message.source.kind !== 'string') return undefined
  // Match Chat's steering display. Other next-step messages include internal agent input.
  if (target === 'next-step' && message.source.kind !== 'user') return undefined

  const blocks: readonly unknown[] = message.content
  const textParts: string[] = []
  const attachments: UserContentAttachment[] = []
  const extraBlocks: unknown[] = []
  for (const block of blocks) {
    if (record(block) && block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text)
      continue
    }
    const attachment = record(block) ? attachmentOf(block) : undefined
    if (attachment === undefined) extraBlocks.push(block)
    else attachments.push(attachment)
  }
  const text = textParts.join('')
  return {
    kind: 'queued', target, id: message.id as MessageId,
    requestId: typeof message.source.rpcId === 'string' ? message.source.rpcId : undefined,
    content: { text, attachments, extraBlocks },
    editable: target === 'next-turn' && textParts.length === blocks.length,
  }
}

function sendingRow(submission: PendingSubmission): SendingRow {
  return {
    kind: 'sending', requestId: submission.requestId,
    content: {
      text: submission.text,
      attachments: submission.attachments.map(attachment => attachment.type === 'file'
        ? { type: 'file', file: attachment.value }
        : { type: 'image', image: { preview: { ...attachment.value, url: attachment.value.previewUrl } } }),
      extraBlocks: [],
    },
  }
}

/** Render one row per occurrence. The Inbox supplies the only IDs that may be withdrawn. */
export function pendingRows(inbox: InboxWireState | undefined, submissions: readonly PendingSubmission[]): PendingRow[] {
  const rows: QueuedRow[] = []
  for (const target of ['next-turn', 'next-step'] as const) {
    for (const message of inbox?.[target] ?? []) {
      const row = queuedRow(message, target)
      if (row !== undefined) rows.push(row)
    }
  }
  const admitted = new Set(rows.map(row => row.requestId))
  const sending = submissions.filter(item => item.placement === 'queued' && !admitted.has(item.requestId))
  return [...rows, ...sending.map(sendingRow)]
}

export function rowKey(row: PendingRow): string {
  return row.requestId === undefined && row.kind === 'queued' ? `message:${row.id}` : `request:${row.requestId}`
}
