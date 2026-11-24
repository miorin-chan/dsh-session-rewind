import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { labels, namespace } from './labels.js'
import { createRewindController } from './rewind.js'
import {
  ComposerAttachmentRestorer,
  inputSlot,
  MessageRewind,
  overlaySlot,
  RewindOverlay,
  rowSlot,
} from './ui.js'

export const inject = [
  'slots',
  'locale',
  'sessions',
  'conversation',
  'uiConversation',
  'uiWorkspace',
  'workspaces',
]

/** Register the rewind locale dictionary, user-message control, attachment restorer, and overlay. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(namespace, labels))
  ctx.effect(() => {
    const lifetime = new AbortController()
    const controller = createRewindController(ctx, lifetime.signal)

    const row = ctx.slots.inject(rowSlot, () => ctx.slots.register({
      name: rowSlot,
      locale: namespace,
      priority: 100,
      inject: () => ({ controller }),
      select: owner => (owner.kind === 'user' ? true : null),
    }, MessageRewind))

    const input = ctx.slots.inject(inputSlot, () => ctx.slots.register({
      name: inputSlot,
      id: namespace,
      locale: namespace,
      inject: (sessionId: SessionId) => {
        const binding = ctx.sessions.binding(sessionId)
        return binding === undefined
          ? { controller }
          : { controller, sessionInput: ctx.conversation.input.for(binding.ctx) }
      },
    }, ComposerAttachmentRestorer))

    const overlay = ctx.slots.inject(overlaySlot, () => ctx.slots.register({
      name: overlaySlot,
      id: `${namespace}.overlay`,
      locale: namespace,
      inject: () => ({ controller }),
    }, RewindOverlay))

    return () => {
      lifetime.abort()
      overlay()
      input()
      row()
    }
  })
}
