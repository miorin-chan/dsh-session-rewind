import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
// Runtime component seeded by DSH 0.2.2-rc.5 from @deepseek-ai/dsh-client-ui-primitives src/index.ts.
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { labels } from './labels.js'
import type { DirectSend } from './direct.js'
import type { Tracker } from './tracker.js'

export const namespace = 'dsh-undo-unsent'
export const inputSlot = 'conversation.input.right'
export const rowSlot = 'conversation.chat.user.before'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-undo-unsent': keyof typeof labels.en
  }
}

type Locale = PropsLocale<typeof namespace>
type Tracked = { readonly tracker?: Tracker }

function UndoButton({ tracker, attempt, t, canRemove, className, row }: Locale & {
  tracker: Tracker
  attempt: DirectSend
  canRemove: boolean
  className?: string | undefined
  row?: boolean
}) {
  return <Tooltip label={t('undo')} side={row ? 'bottom' : 'top'}>
    <button type="button" className={className} aria-label={t('undo')}
      data-dsh-undo-message={row || undefined} data-dsh-undo-direct={!row || undefined}
      onClick={() => { void tracker.undo(attempt, canRemove, {
        undone: t('undone'), restored: t('restored'), unavailable: t('unavailable'),
      }) }}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 5 4 10l5 5M4 10h10a5 5 0 0 1 0 10h-2" />
      </svg>
    </button>
  </Tooltip>
}

export function ComposerUndo(props: PropsRuntime<typeof inputSlot> & Locale & Tracked) {
  if (props.tracker === undefined) return null
  return <ComposerControl {...props} tracker={props.tracker} />
}

function ComposerControl({ tracker, t, useAccess }: PropsRuntime<typeof inputSlot> & Locale & { tracker: Tracker }) {
  useSyncExternalStore(tracker.subscribe, tracker.getSnapshot)
  useLayoutEffect(() => tracker.watch(), [tracker])
  const canRemove = useAccess('session/updateQueue')
  const attempt = tracker.active()
  if (attempt === undefined || (attempt.requestId !== undefined && tracker.inRow() === attempt.requestId)) return null
  return <>
    <style>{composerStyles}</style>
    <UndoButton tracker={tracker} attempt={attempt} t={t} canRemove={canRemove} />
  </>
}

export function MessageUndo(props: PropsRuntime<typeof rowSlot> & Locale & Tracked & { matched: string }) {
  if (props.tracker === undefined) return null
  return <MessageControl {...props} tracker={props.tracker} />
}

function MessageControl({ tracker, matched, t, useAccess }: PropsRuntime<typeof rowSlot> & Locale & {
  tracker: Tracker
  matched: string
}) {
  useSyncExternalStore(tracker.subscribe, tracker.getSnapshot)
  const canRemove = useAccess('session/updateQueue')
  const attempt = tracker.active()
  if (attempt?.requestId !== matched) return null
  return <NativeAction key={matched} tracker={tracker} attempt={attempt} requestId={matched} t={t} canRemove={canRemove} />
}

function NativeAction({ tracker, attempt, requestId, t, canRemove }: Locale & {
  tracker: Tracker
  attempt: DirectSend
  requestId: string
  canRemove: boolean
}) {
  const marker = useRef<HTMLSpanElement>(null)
  const [seat, setSeat] = useState<{ host: HTMLSpanElement; className: string }>()
  useLayoutEffect(() => {
    const bubble = marker.current?.closest(`[data-slot="${rowSlot}"]`)?.parentElement
    if (bubble === null || bubble === undefined) return
    // DSH 0.2.2-rc.5, @deepseek-ai/dsh-client-ui-chat
    // src/client/chat/MessageItem.tsx (UserStyleBubble) and MessageIconActions.tsx.
    // Use the original flex row and its live button class. Only our portal seat is inserted.
    const copy = bubble.querySelector<HTMLButtonElement>(':scope > [data-clock="start"] > button')
    if (copy === null || copy.className === '') return
    const host = copy.ownerDocument.createElement('span')
    host.style.display = 'contents'
    copy.before(host)
    setSeat({ host, className: copy.className })
    const release = tracker.setInRow(requestId)
    return () => { host.remove(); release() }
  }, [requestId, tracker])
  return <>
    <span hidden ref={marker} />
    {seat !== undefined && createPortal(
      <UndoButton tracker={tracker} attempt={attempt} t={t} canRemove={canRemove} className={seat.className} row />,
      seat.host,
    )}
  </>
}

const composerStyles = `
[data-dsh-undo-direct] {
  width: 34px;
  height: 34px;
  display: inline-grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-tertiary);
  background: transparent;
  cursor: pointer;
}
[data-dsh-undo-direct]:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
`
