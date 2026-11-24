import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { createPortal } from 'react-dom'
// Runtime components seeded by DSH 0.2.2-rc.5 from @deepseek-ai/dsh-client-ui-primitives src/index.ts
// (Button, IconWarningOutlineRegular, Modal, Toast, Tooltip).
import {
  Button, IconWarningOutlineRegular, Modal, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/remote'
import type { SessionActivity, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionInput } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isUserChatNode, turnOf } from './content.js'
import { namespace, type LabelKey } from './labels.js'
import type { RewindController, ToastState } from './rewind.js'

export const rowSlot = 'conversation.chat.user.before'
export const inputSlot = 'conversation.input.right'
export const overlaySlot = 'shell.overlay'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-undo-unsent': LabelKey
  }
}

type Locale = PropsLocale<typeof namespace>
type TranslateFn = Locale['t']
type Controlled = { readonly controller?: RewindController }

function RewindGlyph() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.1 11.45A6 6 0 1 0 3.5 4L2.1 5.6" />
      <path d="M2.1 2.4V5.6H5.3" />
    </svg>
  )
}

function RewindPortalSeat({
  anchorRef,
  controller,
  sessionId,
  node,
  busy,
  t,
}: {
  anchorRef: RefObject<HTMLSpanElement | null>
  controller: RewindController
  sessionId: SessionId
  node: ChatNode<'user'>
  busy: boolean
  t: TranslateFn
}) {
  const [seat, setSeat] = useState<{ host: HTMLSpanElement; className: string } | null>(null)
  useLayoutEffect(() => {
    const bubble = anchorRef.current?.closest(`[data-slot="${rowSlot}"]`)?.parentElement
    if (bubble === null || bubble === undefined) return
    // DSH 0.2.2-rc.5, @deepseek-ai/dsh-client-ui-chat
    // src/client/chat/MessageItem.tsx (UserStyleBubble) and MessageIconActions.tsx.
    // Reuse the native actions row and Copy button class; insert only our portal seat before Copy.
    const copy = bubble.querySelector<HTMLButtonElement>(':scope > [data-clock="start"] > button')
    if (copy === null || copy.className === '') return
    const host = copy.ownerDocument.createElement('span')
    host.style.display = 'contents'
    copy.before(host)
    setSeat({ host, className: copy.className })
    return () => {
      host.remove()
      setSeat(null)
    }
  }, [anchorRef, node.key, sessionId])

  if (seat === null) return null
  return createPortal(
    <Tooltip label={t('rewind')} side="bottom">
      <button
        type="button"
        className={seat.className}
        aria-label={t('rewind')}
        aria-busy={busy || undefined}
        disabled={busy}
        data-dsh-rewind-button=""
        onClick={() => { void controller.requestRewind(sessionId, node) }}
      >
        <RewindGlyph />
      </button>
    </Tooltip>,
    seat.host,
  )
}

function WorkspaceRewindSeat({
  workspaceId,
  useWorkspaceAccess,
  anchorRef,
  controller,
  sessionId,
  node,
  busy,
  t,
}: {
  workspaceId: WorkspaceId
  useWorkspaceAccess: PropsRuntime<typeof rowSlot>['useWorkspaceAccess']
  anchorRef: RefObject<HTMLSpanElement | null>
  controller: RewindController
  sessionId: SessionId
  node: ChatNode<'user'>
  busy: boolean
  t: TranslateFn
}) {
  const allowed = useWorkspaceAccess(workspaceId, 'session/create')
  if (!allowed) return null
  return (
    <RewindPortalSeat
      anchorRef={anchorRef}
      controller={controller}
      sessionId={sessionId}
      node={node}
      busy={busy}
      t={t}
    />
  )
}

export function MessageRewind(
  props: PropsRuntime<typeof rowSlot> & Locale & Controlled,
) {
  const {
    controller,
    sessionId,
    useSession,
    useChat,
    useWorkspaces,
    useAccess,
    useWorkspaceAccess,
    t,
  } = props
  const marker = useRef<HTMLSpanElement>(null)
  const [nodeKey, setNodeKey] = useState<string | null>(null)

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.getSnapshot ?? (() => null),
  )
  const subagent = useSession(state => state.subagent)
  const archived = useWorkspaces(state => state.archivedSessionIds.includes(sessionId))
  const workspaceId = useWorkspaces(
    state => state.items.find(item => item.sessionIds.includes(sessionId))?.workspaceId,
  )
  const canArchive = useAccess('workspace/archiveSession')
  const canFork = useAccess('session/fork')
  const canCreateGlobal = useAccess('session/create')
  const node = useChat(chat => (nodeKey === null ? undefined : chat.nodes.get(nodeKey)))

  useLayoutEffect(() => {
    const key = marker.current?.closest('[data-chat-node-key]')?.getAttribute('data-chat-node-key') ?? null
    setNodeKey(previous => (previous === key ? previous : key))
  }, [sessionId])

  const userNode = isUserChatNode(node) ? node : undefined
  const turn = turnOf(userNode)
  const eligible = controller !== undefined
    && userNode !== undefined
    && turn !== undefined
    && subagent === null
    && !archived
    && canArchive

  const busy = snapshot !== null && (snapshot.busySessionId !== null || snapshot.confirm?.pending === true)

  return (
    <>
      <span hidden ref={marker} />
      {eligible && turn <= 1 && workspaceId !== undefined && (
        <WorkspaceRewindSeat
          workspaceId={workspaceId}
          useWorkspaceAccess={useWorkspaceAccess}
          anchorRef={marker}
          controller={controller}
          sessionId={sessionId}
          node={userNode}
          busy={busy}
          t={t}
        />
      )}
      {eligible && (turn > 1 ? canFork : workspaceId === undefined && canCreateGlobal) && (
        <RewindPortalSeat
          anchorRef={marker}
          controller={controller}
          sessionId={sessionId}
          node={userNode}
          busy={busy}
          t={t}
        />
      )}
    </>
  )
}

export function ComposerAttachmentRestorer(
  props: PropsRuntime<typeof inputSlot> & Locale & Controlled & { readonly sessionInput?: SessionInput },
) {
  const { controller, sessionInput, sessionId, useSession, useInput } = props
  const marker = useRef<HTMLSpanElement>(null)
  const mountedRef = useRef(true)
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (fallbackTimerRef.current !== undefined) {
        clearTimeout(fallbackTimerRef.current)
        fallbackTimerRef.current = undefined
      }
    }
  }, [])

  useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.getSnapshot ?? (() => null),
  )
  const openState = useSession(state => state.openState)
  const phase = useInput(state => state.phase)
  const hasPending = controller !== undefined && controller.peekPendingFiles(sessionId) !== undefined

  useEffect(() => {
    if (!hasPending || controller === undefined || sessionInput === undefined) return

    let disposed = false
    let observer: MutationObserver | undefined

    const tryInject = (): boolean => {
      if (disposed || !mountedRef.current || controller.peekPendingFiles(sessionId) === undefined) return true
      const card = marker.current?.closest('[data-composer-card]')
      // DSH 0.2.2-rc.5, @deepseek-ai/dsh-client-ui-conversation
      // src/client/skeleton/InputBar.tsx (cardRef[data-composer-card] & fileInputRef).
      const fileInput = card?.querySelector<HTMLInputElement>('input[type="file"][multiple]') ?? null
      if (fileInput === null || fileInput.disabled) return false

      const files = controller.takePendingFiles(sessionId)
      if (files === undefined || files.length === 0) return true

      const beforeCount = sessionInput.state.getSnapshot().attachmentIds.length
      const transfer = new DataTransfer()
      for (const file of files) transfer.items.add(file)
      fileInput.files = transfer.files
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))

      if (
        sessionInput.state.getSnapshot().attachmentIds.length === beforeCount
        && (fileInput.files?.length ?? 0) > 0
        && typeof ClipboardEvent === 'function'
      ) {
        if (fallbackTimerRef.current !== undefined) clearTimeout(fallbackTimerRef.current)
        fallbackTimerRef.current = setTimeout(() => {
          fallbackTimerRef.current = undefined
          if (!mountedRef.current) return
          if (
            sessionInput.state.getSnapshot().attachmentIds.length === beforeCount
            && (fileInput.files?.length ?? 0) > 0
          ) {
            fileInput.value = ''
            document.dispatchEvent(new ClipboardEvent('paste', {
              clipboardData: transfer,
              cancelable: true,
              bubbles: true,
            }))
          }
          sessionInput.focus()
        }, 0)
      } else {
        sessionInput.focus()
      }
      return true
    }

    if (!tryInject()) {
      const card = marker.current?.closest('[data-composer-card]')
      const fileInput = card?.querySelector<HTMLInputElement>('input[type="file"][multiple]') ?? null
      const observeTarget = fileInput ?? card ?? marker.current?.parentElement ?? null
      if (observeTarget !== null && typeof MutationObserver === 'function') {
        observer = new MutationObserver(() => {
          if (tryInject()) {
            observer?.disconnect()
            observer = undefined
          }
        })
        observer.observe(
          observeTarget,
          fileInput !== null
            ? { attributes: true, attributeFilter: ['disabled'] }
            : { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] },
        )
      }
    }

    return () => {
      disposed = true
      observer?.disconnect()
    }
  }, [controller, sessionInput, sessionId, openState, phase, hasPending])

  if (!hasPending) return null
  return <span hidden ref={marker} />
}

function formatActivityLine(entry: SessionActivity, t: TranslateFn): string {
  const items = entry.items ?? []
  const count = items.length
  const names = items.map(item => item.label ?? item.id).join(t('listSeparator'))
  const one = count === 1
  const kind: string = entry.kind
  switch (kind) {
    case 'turn':
      return t('activityTurn')
    case 'subagent':
      return t(one ? 'activitySubagentsOne' : 'activitySubagentsOther', { n: count, names })
    case 'job':
      return t(one ? 'activityJobsOne' : 'activityJobsOther', { n: count, names })
    case 'schedule':
      return t(one ? 'activitySchedulesOne' : 'activitySchedulesOther', { n: count, names })
    default:
      return t(one ? 'activityOtherOne' : 'activityOtherOther', { kind, n: count })
  }
}

function toastCopy(toast: ToastState, t: TranslateFn): string {
  switch (toast.kind) {
    case 'rewound':
      return t('rewound')
    case 'rewoundPartialAttachments':
      return t('rewoundPartialAttachments', { count: toast.count ?? 0 })
    case 'rewoundNoAttachments':
      return t('rewoundNoAttachments')
    case 'rewindFailed':
      return t('rewindFailed')
    case 'archiveFailed':
      return t('archiveFailed')
    case 'unarchiveFailed':
      return t('unarchiveFailed')
  }
}

export function RewindOverlay(
  props: PropsRuntime<typeof overlaySlot> & Locale & Controlled,
) {
  const { controller, t } = props
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.getSnapshot ?? (() => null),
  )
  if (controller === undefined || snapshot === null) return null

  const { toast, confirm } = snapshot
  return (
    <>
      {toast !== null && (
        <Toast
          key={toast.seq}
          text={toastCopy(toast, t)}
          holdMs={toast.tone === 'warning' ? 7000 : 6000}
          {...(toast.tone === 'success'
            ? { tone: 'success' as const }
            : { icon: <IconWarningOutlineRegular /> })}
          {...(toast.unarchive === undefined
            ? {}
            : {
              actions: [{
                label: t('unarchive'),
                onClick: () => {
                  const target = toast.unarchive
                  if (target !== undefined) {
                    void controller.unarchiveOriginal(target.sessionId, target.wasPinned)
                  }
                },
              }],
            })}
          onDone={() => { controller.dismissToast() }}
        />
      )}
      {confirm !== null && (
        <Modal
          open
          tone="warning"
          onClose={() => { controller.cancelConfirm() }}
          closeLabel={t('close')}
          title={t('confirmTitle')}
          description={t('confirmDesc', { title: confirm.displayTitle })}
          footer={(
            <>
              <Button variant="outline" disabled={confirm.pending} onClick={() => { controller.cancelConfirm() }}>
                {t('cancel')}
              </Button>
              <Button
                variant="outline"
                disabled={confirm.pending}
                style={confirm.pending ? undefined : { color: 'var(--dsw-alias-state-error-primary)' }}
                onClick={() => { void controller.confirmAndProceed() }}
              >
                {confirm.mode === 'archive-only' ? t('confirmArchiveAction') : t('confirmAction')}
              </Button>
            </>
          )}
        >
          <ul
            aria-label={t('confirmActivity')}
            style={{
              margin: '0 0 8px',
              paddingLeft: '18px',
              fontSize: '13px',
              lineHeight: '20px',
              color: 'var(--dsw-alias-label-primary)',
            }}
          >
            {confirm.activity.map((entry, index) => (
              <li key={`${entry.kind}-${String(index)}`} style={{ overflowWrap: 'anywhere' }}>
                {formatActivityLine(entry, t)}
              </li>
            ))}
          </ul>
          {confirm.pending && (
            <div
              role="status"
              style={{
                fontSize: '12px',
                lineHeight: '18px',
                color: 'var(--dsw-alias-label-secondary)',
              }}
            >
              {t('confirmPending')}
            </div>
          )}
          {confirm.error !== undefined && (
            <div
              role="alert"
              style={{
                fontSize: '12px',
                lineHeight: '18px',
                color: 'var(--dsw-alias-state-error-primary)',
                overflowWrap: 'anywhere',
              }}
            >
              {confirm.error}
            </div>
          )}
        </Modal>
      )}
    </>
  )
}
