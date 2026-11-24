import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import type { SessionFace, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type { QueueAction } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ConversationKey, MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { PropsLocale, PropsRenderFactories, PropsRuntime, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { pendingRows, rowKey, type PendingRow } from './rows.js'
import type { labels } from './labels.js'
import { styles } from './styles.js'

export const dockSlot = 'conversation.input.dock'
export const namespace = 'dsh-undo-unsent'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-undo-unsent': keyof typeof labels.en
  }
}

export type DockActions = {
  getSession: () => SessionFace | undefined
  loadImage: MessageImageLoader
  queueText: Translate<ConversationKey>
  notifyError: (text: string) => void
  focusComposer: () => void
}

type DockProps = PropsRuntime<typeof dockSlot> & PropsLocale<typeof namespace> & PropsRenderFactories & DockActions
type RowProps = Pick<DockProps, 't' | 'renderFactorySlot'> & DockActions & {
  row: PendingRow
  canUpdate: boolean
  running: boolean
  onWithdraw: () => void
  onUndoFocus: (button: HTMLButtonElement) => () => void
}

type QueuedRow = Extract<PendingRow, { kind: 'queued' }>
const previewFacts = { collapseWhitespace: true, trimWhitespace: true }

export function PendingDock(props: DockProps) {
  const inbox = props.useProjection('inbox')
  const submissions = props.useSession((session: SessionSnapshot) => session.pendingSubmissions)
  const rows = useMemo(() => pendingRows(inbox, submissions), [inbox, submissions])
  const allowed = props.useAccess('session/updateQueue')
  const canUpdate = allowed && (props.session.subagent === null || props.session.subagent.address.mode === 'continuable')
  return <PendingList key={props.sessionId} {...props} rows={rows} canUpdate={canUpdate} />
}

function PendingList({ rows, session, canUpdate, ...props }: DockProps & {
  rows: readonly PendingRow[]
  canUpdate: boolean
}) {
  const list = useRef<HTMLUListElement>(null)
  const focusedUndo = useRef<HTMLButtonElement | null>(null)
  const [withdrawn, setWithdrawn] = useState(0)
  useEffect(() => {
    if (withdrawn === 0) return
    const timeout = setTimeout(() => setWithdrawn(0), 2500)
    return () => clearTimeout(timeout)
  }, [withdrawn])
  const last = rows.at(-1)
  const lastKey = last === undefined ? undefined : rowKey(last)
  useLayoutEffect(() => {
    const element = list.current
    if (element !== null && !element.contains(element.ownerDocument.activeElement)) {
      element.scrollTop = element.scrollHeight
    }
  }, [lastKey])
  useLayoutEffect(() => {
    const button = focusedUndo.current
    if (button === null || button.isConnected) return
    focusedUndo.current = null
    const doc = button.ownerDocument
    if (doc.activeElement !== doc.body) return
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>('[data-dsh-undo]:not([aria-disabled="true"])')
    const next = buttons?.[buttons.length - 1]
    if (next !== undefined) next.focus()
    else props.focusComposer()
  }, [rows, props.focusComposer])

  function rememberFocus(button: HTMLButtonElement): () => void {
    focusedUndo.current = button
    return () => {
      if (focusedUndo.current === button && button.isConnected) focusedUndo.current = null
    }
  }

  return (
    <>
      <style>{styles}</style>
      {rows.length > 0 && <div className="dsh-undo-unsent" data-dsh-undo-unsent data-queue-dock="">
        <div className="dsh-undo-heading" aria-hidden="true">{props.t('pending')}</div>
        <ul ref={list} aria-label={props.t('pending')} className="dsh-undo-list">
          {rows.map(row => <PendingMessage key={rowKey(row)} row={row} canUpdate={canUpdate}
            running={session.running} onWithdraw={() => setWithdrawn(count => count + 1)}
            onUndoFocus={rememberFocus} {...props} />)}
        </ul>
      </div>}
      <div className="dsh-undo-announcement" data-visible={withdrawn > 0 ? '' : undefined} role="status">
        {withdrawn > 0 && <span key={withdrawn}>{props.t('undone')}</span>}
      </div>
    </>
  )
}

function PendingMessage({ row, t, queueText, renderFactorySlot, loadImage, ...props }: RowProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const status = row.kind === 'sending' ? queueText('queue.sending')
    : row.target === 'next-step' ? t('steering') : t('queued')
  const editing = row.kind === 'queued' && row.editable && props.canUpdate && draft !== null
  const empty = row.content.text === '' && row.content.attachments.length === 0 && row.content.extraBlocks.length === 0
  return (
    <li className="dsh-undo-row" data-dsh-undo-row={row.kind === 'queued' ? row.target : 'sending'}>
      <span className="dsh-undo-state">{status}</span>
      {editing ? (
        <textarea className="dsh-undo-edit" aria-label={queueText('queue.edit')} rows={2} autoFocus value={draft}
          onChange={event => setDraft(event.currentTarget.value)} onKeyDown={event => {
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
              event.stopPropagation()
              setDraft(null)
            }
          }} />
      ) : (
        <div className="dsh-undo-preview">
          {empty ? t('empty') : renderFactorySlot('conversation.chat.user.content', {
            content: row.content, facts: previewFacts, loadImage, ellipsis: true,
          })}
        </div>
      )}
      {row.kind === 'queued' && props.canUpdate && <MessageActions key={row.id} row={row} t={t} queueText={queueText}
        draft={editing ? draft : null} setDraft={setDraft} {...props} />}
    </li>
  )
}

type ActionProps = Pick<RowProps, 'getSession' | 't' | 'notifyError' | 'queueText' | 'running' | 'onWithdraw' | 'onUndoFocus'> & {
  row: QueuedRow
  draft: string | null
  setDraft: (text: string | null) => void
}

function MessageActions({ row, draft, setDraft, getSession, notifyError, t, queueText, running, onWithdraw, onUndoFocus }: ActionProps) {
  const [busy, setBusy] = useState<QueueAction['kind'] | null>(null)
  const inFlight = useRef(false)
  const editing = draft !== null
  const undoing = busy === 'remove'

  async function apply(action: QueueAction, releaseFocus?: () => void): Promise<void> {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(action.kind)
    let result: Awaited<ReturnType<SessionFace['updateQueue']>> | undefined
    try {
      result = await getSession()?.updateQueue(row.id, action)
    } catch {
      result = undefined
    }
    if (result?.ok && action.kind === 'remove') {
      // Keep the arrow disabled until the Inbox projection removes the row.
      onWithdraw()
      return
    }
    releaseFocus?.()
    inFlight.current = false
    setBusy(null)
    if (result?.ok) {
      if (action.kind === 'edit') setDraft(null)
      return
    }
    const code = result?.error.code
    switch (action.kind) {
      case 'remove':
        notifyError(t(code === 'session/queue-item-not-found' ? 'tooLate' : 'failed'))
        break
      case 'edit':
        notifyError(queueText('queue.editFailed'))
        break
      case 'steer':
        // The native queue also treats these races as converged.
        if (code !== 'session/steer-unavailable' && code !== 'session/queue-item-not-found') {
          notifyError(queueText('queue.steerFailed'))
        }
        break
    }
  }

  return (
    <div className="dsh-undo-actions">
      {row.target === 'next-turn' && (editing ? (
        <>
          <Action glyph="save" label={queueText('queue.save')} disabled={busy !== null || draft.trim() === ''}
            onClick={() => { void apply({ kind: 'edit', content: [{ type: 'text', text: draft }] }) }} />
          <Action glyph="close" label={queueText('queue.cancelEdit')} disabled={busy !== null} onClick={() => setDraft(null)} />
        </>
      ) : (
        <>
          <Action glyph="edit" label={queueText('queue.edit')} disabled={busy !== null || !row.editable}
            hint={!row.editable ? queueText('queue.edit.unsupported') : undefined} onClick={() => setDraft(row.content.text)} />
          <Action glyph="steer" label={queueText('queue.steer')} disabled={busy !== null || !running}
            hint={!running ? queueText('queue.steer.unavailable') : undefined} onClick={() => { void apply({ kind: 'steer' }) }} />
        </>
      ))}
      <Action glyph="undo" label={t(undoing ? 'undoing' : 'undo')} disabled={busy !== null}
        onClick={event => {
          const button = event.currentTarget
          const releaseFocus = event.detail === 0 && button.ownerDocument.activeElement === button
            ? onUndoFocus(button) : undefined
          void apply({ kind: 'remove' }, releaseFocus)
        }} />
    </div>
  )
}

const paths = {
  undo: 'M9 5 4 10l5 5M4 10h10a5 5 0 0 1 0 10h-2',
  edit: 'm5 15-1 5 5-1L20 8l-4-4ZM14 6l4 4',
  steer: 'm4 10 16-6-6 16-2.5-7.5L4 10Zm7.5 2.5L20 4',
  save: 'm5 12 4 4 10-10',
  close: 'm6 6 12 12M18 6 6 18',
}

function Action({ glyph, label, hint, disabled, onClick }: {
  glyph: keyof typeof paths
  label: string
  hint?: string
  disabled: boolean
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
}) {
  return (
    <button className="dsh-undo-action" type="button" data-dsh-undo={glyph === 'undo' ? '' : undefined}
      title={hint ?? label} aria-label={label} aria-disabled={disabled || undefined}
      onClick={event => { if (!disabled) onClick(event) }}>
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="17" height="17"
        fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d={paths[glyph]} />
      </svg>
    </button>
  )
}
