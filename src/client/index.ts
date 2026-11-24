import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PendingDock, dockSlot, namespace, type DockActions } from './dock.js'
import { labels } from './labels.js'

export const inject = ['slots', 'locale', 'sessions', 'conversation', 'uiConversation']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(namespace, labels))
  ctx.effect(() => ctx.slots.inject(dockSlot, () => ctx.slots.register({
    name: dockSlot,
    // The shipped queue occupies this list cell at order 20 and priority 0.
    id: 'queue', order: 20, priority: -1, locale: namespace,
    inject: (sessionId): DockActions => ({
      getSession: () => ctx.sessions.binding(sessionId)?.session,
      loadImage: attachment => ctx.uiConversation.imageUrl(sessionId, attachment),
      queueText: ctx.locale.bind('conversation'),
      notifyError: (text) => {
        const scope = ctx.sessions.scope(sessionId)
        if (scope !== undefined) ctx.conversation.input.for(scope).notify('error', text)
      },
      focusComposer: () => {
        const scope = ctx.sessions.scope(sessionId)
        if (scope !== undefined) ctx.conversation.input.for(scope).focus()
      },
    }),
  }, PendingDock)))
}
