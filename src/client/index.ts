import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ComposerUndo, MessageUndo, inputSlot, namespace, rowSlot } from './button.js'
import { requestOf } from './direct.js'
import { labels } from './labels.js'
import { trackSession, type Tracker } from './tracker.js'

export const inject = ['slots', 'locale', 'sessions', 'conversation', 'uiConversation']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(namespace, labels))
  ctx.effect(() => {
    const lifetime = new AbortController()
    const trackers = new WeakMap<SessionBinding, Tracker>()
    function trackerFor(sessionId: SessionBinding['sessionId']) {
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return {}
      let tracker = trackers.get(binding)
      if (tracker === undefined) {
        tracker = trackSession(ctx, binding, lifetime.signal)
        trackers.set(binding, tracker)
      }
      return { tracker }
    }
    const input = ctx.slots.inject(inputSlot, () => ctx.slots.register({
      name: inputSlot, id: namespace, locale: namespace, inject: trackerFor,
    }, ComposerUndo))
    const row = ctx.slots.inject(rowSlot, () => ctx.slots.register({
      name: rowSlot, locale: namespace, priority: 100, inject: trackerFor,
      select: owner => owner.kind === 'user' ? requestOf(owner.source) ?? null : null,
    }, MessageUndo))
    return () => { lifetime.abort(); row(); input() }
  })
}
