import type { Context } from '@deepseek-ai/cordis'
import type { SessionBinding, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { directMessage, inputFrozen, matchingInboxId, replyStarted, turnOf, type DirectSend } from './direct.js'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    undoDirectSend: unknown
  }
}

function findAcceptance(attempt: DirectSend, state: SessionSnapshot) {
  return state.pendingSubmissions.find(echo => echo.placement === 'transcript'
    && !attempt.beforeRequests.has(echo.requestId))
}

export function trackSession(ctx: Context, binding: SessionBinding, lifetime: AbortSignal) {
  const session = binding.session
  const input = ctx.conversation.input.for(binding.ctx)
  const chat = ctx.uiConversation.binding(binding).target('chat')
  const inbox = session.projections.faceOf('inbox')
  const listeners = new Set<() => void>()
  let revision = 0
  let attempt: DirectSend | undefined
  let inRow: string | undefined
  let previousInput = input.state.getSnapshot()
  let stepStop = () => {}
  let subscribedTurn: number | undefined

  function publish() {
    revision++
    for (const listener of listeners) listener()
  }

  function refresh() {
    const editor = input.state.getSnapshot()
    const state: SessionSnapshot = session.getSnapshot()
    const snapshot = chat.getSnapshot()
    let changed = false
    if (editor.phase === 'sending' && previousInput.phase !== 'sending' && !state.running
      && editor.draft.trim() !== '') {
      attempt = {
        draft: editor.draft,
        revision: editor.draftRev,
        beforeRequests: new Set(state.pendingSubmissions.map(submission => submission.requestId)),
        previousTurn: snapshot?.timeline.turnOrder.at(-1),
      }
      changed = true
    }
    previousInput = editor
    if (attempt !== undefined) {
      const accepted = findAcceptance(attempt, state)
      if (attempt.requestId === undefined && accepted !== undefined) {
        attempt.requestId = accepted.requestId
        changed = true
      }
      const turn = turnOf(directMessage(snapshot, attempt.requestId))
      if (turn !== subscribedTurn) {
        stepStop()
        subscribedTurn = turn
        stepStop = turn === undefined || snapshot === undefined ? () => {}
          : snapshot.nodes.turnDataSource(turn, 'assistant-step').subscribe(refresh)
      }
      const newestTurn = snapshot?.timeline.turnOrder.at(-1)
      const finished = turn !== undefined && snapshot !== undefined
        && (snapshot.timeline.turns.get(turn)?.status === 'closed' || replyStarted(snapshot, turn))
      const settledWithoutEcho = !inputFrozen(editor) && attempt.requestId === undefined
        && (editor.draft === attempt.draft || newestTurn !== attempt.previousTurn || state.promptError?.op === 'send')
      if (state.removed || finished || settledWithoutEcho) {
        attempt = undefined
        changed = true
      }
    }
    if (changed) publish()
  }

  function watch() {
    previousInput = input.state.getSnapshot()
    const unsubscribe = [input.state, session, chat].map(source => source.subscribe(refresh))
    refresh()
    return () => {
      for (const dispose of unsubscribe) dispose()
      stepStop()
      subscribedTurn = undefined
    }
  }

  async function undo(target: DirectSend, canRemove: boolean, messages: { undone: string; restored: string; unavailable: string }) {
    refresh()
    if (attempt !== target || target.clicked || lifetime.aborted) return
    target.clicked = true
    publish()

    try {
      await ctx.sessions.using(binding.sessionId, { source: 'undoDirectSend', signal: lifetime }, async reference => {
        if (reference.binding !== binding) return
        const { restored, removed } = await restoreAndWithdraw(target, canRemove)
        if (lifetime.aborted) return
        const notice = removed ? messages.undone : messages.restored
        input.notify(restored ? 'info' : 'error', restored ? notice : messages.unavailable)
      })
    } catch {
      if (!lifetime.aborted && ctx.sessions.binding(binding.sessionId) === binding) input.notify('error', messages.unavailable)
    }
  }

  async function restoreAndWithdraw(target: DirectSend, canRemove: boolean) {
    let removal: Promise<boolean> | undefined
    const restored = await new Promise<boolean>(resolve => {
      const abort = () => { stopWaiting(); resolve(false) }
      const offInput = input.state.subscribe(settle)
      const offSession = session.subscribe(settle)
      const offInbox = inbox.subscribe(settle)
      function stopWaiting() {
        offInput()
        offSession()
        offInbox()
        lifetime.removeEventListener('abort', abort)
      }
      function settle() {
        const state: SessionSnapshot = session.getSnapshot()
        if (lifetime.aborted || state.removed) { abort(); return }
        const requestId = target.requestId ?? findAcceptance(target, state)?.requestId
        const id = canRemove && requestId !== undefined ? matchingInboxId(session, requestId) : undefined
        if (id !== undefined && removal === undefined) {
          removal = Promise.resolve().then(async () => (await session.updateQueue(id, { kind: 'remove' })).ok).catch(() => false)
        }
        // Native sending owns the editor until it settles. Use the latest
        // draft once it unlocks, even if the reply arrived after the click.
        const editor = input.state.getSnapshot()
        if (inputFrozen(editor)) return
        stopWaiting()
        if (editor.draft === target.draft && editor.draftRev === target.revision) { resolve(true); return }
        const prompt = editor.draft === '' || editor.draft.endsWith('\n') ? target.draft : `\n${target.draft}`
        try {
          const result = ctx.conversation.input.requestDraftInitialization(binding, { prompt, whenDraftExists: 'append' })
          resolve(result === 'applied')
        } catch {
          resolve(false)
        }
      }
      lifetime.addEventListener('abort', abort, { once: true })
      settle()
    })
    return { restored, removed: await removal ?? false }
  }

  return {
    watch,
    undo,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => revision,
    active: () => attempt?.clicked === true ? undefined : attempt,
    inRow: () => inRow,
    setInRow(requestId: string) {
      inRow = requestId
      publish()
      return () => {
        if (inRow !== requestId) return
        inRow = undefined
        publish()
      }
    },
  }
}

export type Tracker = ReturnType<typeof trackSession>
