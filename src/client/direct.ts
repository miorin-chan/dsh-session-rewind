import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import type { AssistantChatData, ChatNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'

export interface DirectSend {
  readonly draft: string
  readonly revision: number
  readonly beforeRequests: ReadonlySet<string>
  readonly previousTurn: number | undefined
  requestId?: string
  clicked?: boolean
}

export function requestOf(source: unknown): string | undefined {
  if (typeof source !== 'object' || source === null || !('rpcId' in source)) return undefined
  return typeof source.rpcId === 'string' && source.rpcId !== '' ? source.rpcId : undefined
}

export function directMessage(chat: ChatSnapshot | undefined, requestId: string | undefined) {
  if (chat === undefined || requestId === undefined) return undefined
  const node = chat.nodes.values().find(value => value.kind === 'user'
    && requestOf((value as ChatNode<'user'>).data.source) === requestId) as ChatNode<'user'> | undefined
  return node
}

export function turnOf(node: ChatNode<'user'> | undefined): number | undefined {
  const location = node?.location
  return location?.kind === 'step' || location?.kind === 'turn' ? location.turn.turn : undefined
}

export function replyStarted(chat: ChatSnapshot, turn: number): boolean {
  return chat.nodes.turnDataSource(turn, 'assistant-step').getSnapshot().some((step: AssistantChatData) =>
    step.blocks.some(block => block.kind === 'text' && block.text.trim() !== ''))
}

export function matchingInboxId(session: SessionFace, requestId: string): MessageId | undefined {
  const inbox = session.projections.faceOf('inbox').getSnapshot()
  if (typeof inbox !== 'object' || inbox === null || !('next-turn' in inbox)) return undefined
  const rows: unknown = inbox['next-turn']
  if (!Array.isArray(rows)) return undefined
  for (const row of rows as unknown[]) {
    if (typeof row !== 'object' || row === null || !('source' in row) || !('id' in row) || !('role' in row)) continue
    if (row.role === 'user' && requestOf(row.source) === requestId && typeof row.id === 'string' && row.id !== '') {
      return row.id as MessageId
    }
  }
  return undefined
}

export function inputFrozen(input: InputState): boolean {
  return input.phase === 'sending' || input.phase === 'adjudicating' || input.phase === 'submitting'
}
