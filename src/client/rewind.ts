import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionActivity, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  activeSessionRefusal,
  clientRewindBoundary,
  extractMessagePayload,
  fallbackImageName,
  hasNonTurnActivity,
  inheritedInboxIds,
  parsePrepareResponse,
  type RewindBoundary,
} from './content.js'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    rewind: unknown
  }
}

export const PREPARE_PATH = '/api/dsh-session-rewind/prepare'
export const FILE_PATH = '/api/dsh-session-rewind/file'

const MAX_LOAD_OLDER_STEPS = 200
const PREPARE_TIMEOUT_MS = 15_000
const FILE_TIMEOUT_MS = 30_000

export type ConfirmState =
  | {
    readonly mode: 'rewind'
    readonly sessionId: SessionId
    readonly displayTitle: string
    readonly node: ChatNode<'user'>
    readonly boundary: RewindBoundary
    readonly activity: readonly SessionActivity[]
    readonly pending: boolean
    readonly error?: string
  }
  | {
    readonly mode: 'archive-only'
    readonly sessionId: SessionId
    readonly displayTitle: string
    readonly activity: readonly SessionActivity[]
    readonly wasPinned: boolean
    readonly totalAttachments: number
    readonly failedAttachments: number
    readonly pending: boolean
    readonly error?: string
  }

export type ToastKind =
  | 'rewound'
  | 'rewoundPartialAttachments'
  | 'rewoundNoAttachments'
  | 'rewindFailed'
  | 'archiveFailed'
  | 'unarchiveFailed'

export interface ToastState {
  readonly seq: number
  readonly tone: 'success' | 'warning'
  readonly kind: ToastKind
  readonly count?: number
  readonly unarchive?: {
    readonly sessionId: SessionId
    readonly wasPinned: boolean
  }
}

export interface RewindControllerSnapshot {
  readonly revision: number
  readonly busySessionId: SessionId | null
  readonly confirm: ConfirmState | null
  readonly toast: ToastState | null
}

export interface RewindControllerDeps {
  readonly fetch?: typeof fetch
  readonly pendingFilesTtlMs?: number
}

const DEFAULT_PENDING_FILES_TTL_MS = 60_000

type ExecuteOutcome =
  | {
    readonly ok: true
    readonly wasPinned: boolean
    readonly totalAttachments: number
    readonly failedAttachments: number
    readonly hasText: boolean
  }
  | { readonly ok: false; readonly stage: 'before-switch' | 'archive'; readonly message: string }
  | {
    readonly ok: false
    readonly stage: 'archive-confirm'
    readonly activity: readonly SessionActivity[]
    readonly wasPinned: boolean
    readonly totalAttachments: number
    readonly failedAttachments: number
  }

function baseUrl(): string {
  if (typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== '') {
    return document.baseURI
  }
  return 'http://localhost/'
}

function buildRouteUrl(path: string, params: Record<string, string>): string {
  const url = new URL(path.slice(1), baseUrl())
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

function isInvalidPresetCreateError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'SessionCreateError') return false
  if (!('rpcError' in error)) return false
  const rpcError = (error as { readonly rpcError?: unknown }).rpcError
  if (typeof rpcError !== 'object' || rpcError === null || !('code' in rpcError)) return false
  const code = (rpcError as { readonly code?: unknown }).code
  return code === 'agent-preset/not-found' || code === 'agent-preset/invalid'
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Coordinates session rewind, multimedia extraction, confirmation, and unarchive toasts. */
export function createRewindController(
  ctx: Context,
  lifetime: AbortSignal,
  deps: RewindControllerDeps = {},
) {
  const fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const pendingFilesTtlMs = deps.pendingFilesTtlMs ?? DEFAULT_PENDING_FILES_TTL_MS
  const listeners = new Set<() => void>()
  const pendingFiles = new Map<SessionId, readonly File[]>()
  const pendingFileTimers = new Map<SessionId, ReturnType<typeof setTimeout>>()
  let revision = 0
  let toastSeq = 0
  let busySessionId: SessionId | null = null
  let confirm: ConfirmState | null = null
  let toast: ToastState | null = null
  let snapshot: RewindControllerSnapshot = {
    revision,
    busySessionId,
    confirm,
    toast,
  }

  function clearPendingFiles(targetId: SessionId): void {
    const timer = pendingFileTimers.get(targetId)
    if (timer !== undefined) {
      clearTimeout(timer)
      pendingFileTimers.delete(targetId)
    }
    pendingFiles.delete(targetId)
  }

  function setPendingFiles(targetId: SessionId, files: readonly File[]): void {
    clearPendingFiles(targetId)
    pendingFiles.set(targetId, files)
    if (pendingFilesTtlMs > 0) {
      const timer = setTimeout(() => {
        pendingFileTimers.delete(targetId)
        if (pendingFiles.delete(targetId)) publish()
      }, pendingFilesTtlMs)
      ;(timer as { unref?: () => void }).unref?.()
      pendingFileTimers.set(targetId, timer)
    }
  }

  lifetime.addEventListener('abort', () => {
    for (const timer of pendingFileTimers.values()) clearTimeout(timer)
    pendingFileTimers.clear()
    pendingFiles.clear()
  }, { once: true })

  function publish() {
    revision += 1
    snapshot = { revision, busySessionId, confirm, toast }
    for (const listener of [...listeners]) listener()
  }

  function showToast(next: Omit<ToastState, 'seq'>) {
    toastSeq += 1
    toast = { ...next, seq: toastSeq }
    publish()
  }

  function dismissToast() {
    if (toast === null) return
    toast = null
    publish()
  }

  function displayTitleOf(sessionId: SessionId): string {
    return ctx.sessions.list.getSnapshot().byId[sessionId]?.title ?? sessionId
  }

  async function resolveClientBoundary(
    binding: SessionBinding,
    node: ChatNode<'user'>,
  ): Promise<RewindBoundary | undefined> {
    const chat = ctx.uiConversation.binding(binding).target('chat')
    let boundary = clientRewindBoundary(chat.getSnapshot(), node)
    for (let step = 0; step < MAX_LOAD_OLDER_STEPS && boundary === undefined; step++) {
      if (lifetime.aborted) return undefined
      const state = binding.session.getSnapshot()
      if (!state.hasMore || state.historyLoadStatus === 'error') break
      await binding.session.loadOlder()
      if (lifetime.aborted) return undefined
      boundary = clientRewindBoundary(chat.getSnapshot(), node)
    }
    return boundary
  }

  async function prepareOnHost(
    sessionId: SessionId,
    seq: number,
  ): Promise<{ boundary: RewindBoundary; activity: readonly SessionActivity[] } | undefined> {
    try {
      const url = buildRouteUrl(PREPARE_PATH, { sessionId, seq: String(seq) })
      const response = await fetchImpl(url, {
        signal: AbortSignal.any([lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)]),
      })
      if (!response.ok) return undefined
      const data: unknown = await response.json()
      return parsePrepareResponse(data)
    } catch {
      return undefined
    }
  }

  async function collectAttachmentFiles(
    binding: SessionBinding,
    node: ChatNode<'user'>,
  ): Promise<{ readonly files: readonly File[]; readonly failedAttachments: number }> {
    const { attachments } = extractMessagePayload(node.data.content)
    const files: File[] = []
    let failedAttachments = 0
    let imageOrdinal = 0
    for (const attachment of attachments) {
      if (lifetime.aborted) break
      if (attachment.kind === 'image') {
        imageOrdinal += 1
        try {
          const result = await binding.session.readAttachment(attachment.ref)
          if (result.ok) {
            const bytes = new Uint8Array(result.value.data)
            const name = result.value.attachment.name ?? fallbackImageName(result.value.attachment.mediaType, imageOrdinal)
            files.push(new File([bytes], name, { type: result.value.attachment.mediaType }))
          } else {
            failedAttachments += 1
          }
        } catch {
          failedAttachments += 1
        }
        continue
      }

      try {
        const url = buildRouteUrl(FILE_PATH, {
          sessionId: binding.sessionId,
          seq: String(node.data.seq),
          index: String(attachment.index),
          attachmentId: attachment.ref.attachmentId,
        })
        const response = await fetchImpl(url, {
          signal: AbortSignal.any([lifetime, AbortSignal.timeout(FILE_TIMEOUT_MS)]),
        })
        if (response.ok) {
          const bytes = await response.arrayBuffer()
          files.push(new File([bytes], attachment.ref.name, { type: 'application/octet-stream' }))
        } else {
          failedAttachments += 1
        }
      } catch {
        failedAttachments += 1
      }
    }
    return { files, failedAttachments }
  }

  async function executeRewind(params: {
    readonly sessionId: SessionId
    readonly node: ChatNode<'user'>
    readonly boundary: RewindBoundary
    readonly stopActivity: boolean
  }): Promise<ExecuteOutcome> {
    const { sessionId, node, boundary, stopActivity } = params
    const sourceBinding = ctx.sessions.binding(sessionId)
    if (sourceBinding === undefined || lifetime.aborted) {
      return { ok: false, stage: 'before-switch', message: 'Session unavailable' }
    }

    const { text, attachments } = extractMessagePayload(node.data.content)
    const { files, failedAttachments } = await collectAttachmentFiles(sourceBinding, node)
    if (lifetime.aborted) {
      return { ok: false, stage: 'before-switch', message: 'Aborted' }
    }

    const workspaces = ctx.workspaces.list.getSnapshot()
    const sessions = ctx.sessions.list.getSnapshot()
    const workspace = workspaces.items.find(item => item.sessionIds.includes(sessionId))
    const wasPinned = workspaces.pinnedSessionIds.includes(sessionId)
    const summary = sessions.byId[sessionId]
    const rawPreset = summary?.projectionValues?.agentPreset
    const agentPreset = typeof rawPreset === 'string' && rawPreset !== '' ? rawPreset : undefined

    let childId: SessionId
    try {
      if (boundary.kind === 'fork') {
        childId = await ctx.sessions.fork({
          sessionId,
          atSeq: boundary.atSeq,
          increaseTitle: false,
        })
      } else {
        const baseCreateOpts: {
          workspaceId?: WorkspaceId
          cwd?: string
        } = {}
        if (workspace !== undefined) baseCreateOpts.workspaceId = workspace.workspaceId
        else if (summary?.cwd !== undefined) baseCreateOpts.cwd = summary.cwd
        if (agentPreset === undefined) {
          childId = await ctx.sessions.create(baseCreateOpts)
        } else {
          try {
            childId = await ctx.sessions.create({ ...baseCreateOpts, agentPreset })
          } catch (error: unknown) {
            if (!isInvalidPresetCreateError(error)) throw error
            childId = await ctx.sessions.create(baseCreateOpts)
          }
        }
      }
    } catch (error: unknown) {
      return { ok: false, stage: 'before-switch', message: errorMessageOf(error) }
    }

    try {
      await ctx.sessions.using(childId, { source: 'rewind', signal: lifetime }, async (reference) => {
        if (boundary.kind === 'fork') {
          await reference.ready
          for (const itemId of inheritedInboxIds(reference.binding.session)) {
            await reference.binding.session.updateQueue(itemId, { kind: 'remove' }).catch(() => {})
          }
        }
        if (text !== '') {
          const result = ctx.conversation.input.requestDraftInitialization(reference.binding, {
            prompt: text,
            whenDraftExists: 'replace',
          })
          if (result === 'blocked') {
            throw new Error('Could not initialize the composer draft')
          }
        }
        if (files.length > 0) {
          setPendingFiles(childId, files)
          publish()
        }
        if (wasPinned) {
          await ctx.uiWorkspace.pinSession(childId).catch(() => {})
        }
        if (workspace !== undefined) {
          await ctx.workspaces.insertSessionBefore(workspace.workspaceId, childId, sessionId).catch(() => {})
        }
        ctx.uiWorkspace.openSession(childId)
        try {
          ctx.conversation.input.for(reference.binding.ctx).focus()
        } catch {
          // Focus is best-effort if the editor mounts asynchronously after navigation.
        }
      })
    } catch (error: unknown) {
      clearPendingFiles(childId)
      return { ok: false, stage: 'before-switch', message: errorMessageOf(error) }
    }

    if (lifetime.aborted) {
      return { ok: false, stage: 'archive', message: 'Aborted' }
    }

    try {
      await ctx.uiWorkspace.archiveSession(sessionId, stopActivity ? { stopActivity: true } : undefined)
    } catch (error: unknown) {
      const refused = activeSessionRefusal(error)
      if (!stopActivity && refused !== undefined) {
        if (!hasNonTurnActivity(refused)) {
          try {
            await ctx.uiWorkspace.archiveSession(sessionId, { stopActivity: true })
          } catch (retryError: unknown) {
            return { ok: false, stage: 'archive', message: errorMessageOf(retryError) }
          }
        } else {
          return {
            ok: false,
            stage: 'archive-confirm',
            activity: refused,
            wasPinned,
            totalAttachments: attachments.length,
            failedAttachments,
          }
        }
      } else {
        return { ok: false, stage: 'archive', message: errorMessageOf(error) }
      }
    }

    return {
      ok: true,
      wasPinned,
      totalAttachments: attachments.length,
      failedAttachments,
      hasText: text !== '',
    }
  }

  function showSuccessToast(
    sessionId: SessionId,
    wasPinned: boolean,
    totalAttachments: number,
    failedAttachments: number,
  ) {
    if (failedAttachments === 0) {
      showToast({
        tone: 'success',
        kind: 'rewound',
        unarchive: { sessionId, wasPinned },
      })
      return
    }
    if (failedAttachments >= totalAttachments) {
      showToast({
        tone: 'warning',
        kind: 'rewoundNoAttachments',
        unarchive: { sessionId, wasPinned },
      })
      return
    }
    showToast({
      tone: 'warning',
      kind: 'rewoundPartialAttachments',
      count: failedAttachments,
      unarchive: { sessionId, wasPinned },
    })
  }

  async function requestRewind(sessionId: SessionId, node: ChatNode<'user'>): Promise<void> {
    if (lifetime.aborted || busySessionId !== null) return
    busySessionId = sessionId
    publish()

    try {
      const sourceBinding = ctx.sessions.binding(sessionId)
      if (sourceBinding === undefined) {
        busySessionId = null
        showToast({ tone: 'warning', kind: 'rewindFailed' })
        return
      }

      const prepared = await prepareOnHost(sessionId, node.data.seq)
      if (lifetime.aborted) return
      const boundary = prepared?.boundary ?? await resolveClientBoundary(sourceBinding, node)
      if (lifetime.aborted) return

      if (boundary === undefined) {
        busySessionId = null
        showToast({ tone: 'warning', kind: 'rewindFailed' })
        return
      }

      const activity = prepared?.activity
      if (activity !== undefined && hasNonTurnActivity(activity)) {
        busySessionId = null
        confirm = {
          mode: 'rewind',
          sessionId,
          displayTitle: displayTitleOf(sessionId),
          node,
          boundary,
          activity,
          pending: false,
        }
        publish()
        return
      }

      const stopActivity = activity?.some(entry => entry.kind === 'turn') === true
      const outcome = await executeRewind({ sessionId, node, boundary, stopActivity })
      busySessionId = null
      if (lifetime.aborted) return

      if (outcome.ok) {
        showSuccessToast(sessionId, outcome.wasPinned, outcome.totalAttachments, outcome.failedAttachments)
      } else if (outcome.stage === 'before-switch') {
        showToast({ tone: 'warning', kind: 'rewindFailed' })
      } else if (outcome.stage === 'archive-confirm') {
        confirm = {
          mode: 'archive-only',
          sessionId,
          displayTitle: displayTitleOf(sessionId),
          activity: outcome.activity,
          wasPinned: outcome.wasPinned,
          totalAttachments: outcome.totalAttachments,
          failedAttachments: outcome.failedAttachments,
          pending: false,
        }
        publish()
      } else {
        showToast({ tone: 'warning', kind: 'archiveFailed' })
      }
    } catch {
      busySessionId = null
      if (!lifetime.aborted) showToast({ tone: 'warning', kind: 'rewindFailed' })
    }
  }

  async function confirmAndProceed(): Promise<void> {
    const active = confirm
    if (active === null || active.pending || lifetime.aborted) return
    confirm = { ...active, pending: true }
    publish()

    if (active.mode === 'archive-only') {
      try {
        await ctx.uiWorkspace.archiveSession(active.sessionId, { stopActivity: true })
        confirm = null
        showSuccessToast(
          active.sessionId,
          active.wasPinned,
          active.totalAttachments,
          active.failedAttachments,
        )
      } catch (error: unknown) {
        confirm = { ...active, pending: false, error: errorMessageOf(error) }
        publish()
      }
      return
    }

    const outcome = await executeRewind({
      sessionId: active.sessionId,
      node: active.node,
      boundary: active.boundary,
      stopActivity: true,
    })
    if (lifetime.aborted) return

    if (outcome.ok) {
      confirm = null
      showSuccessToast(active.sessionId, outcome.wasPinned, outcome.totalAttachments, outcome.failedAttachments)
    } else if (outcome.stage === 'before-switch') {
      confirm = { ...active, pending: false, error: outcome.message }
      publish()
    } else {
      confirm = null
      showToast({ tone: 'warning', kind: 'archiveFailed' })
    }
  }

  function cancelConfirm(): void {
    if (confirm === null || confirm.pending) return
    confirm = null
    publish()
  }

  async function unarchiveOriginal(sessionId: SessionId, wasPinned: boolean): Promise<void> {
    dismissToast()
    if (lifetime.aborted) return
    try {
      await ctx.uiWorkspace.unarchiveSession(sessionId)
      if (wasPinned) {
        await ctx.uiWorkspace.pinSession(sessionId).catch(() => {})
      }
      ctx.uiWorkspace.openSession(sessionId)
    } catch {
      if (!lifetime.aborted) showToast({ tone: 'warning', kind: 'unarchiveFailed' })
    }
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: (): RewindControllerSnapshot => snapshot,
    requestRewind,
    confirmAndProceed,
    cancelConfirm,
    dismissToast,
    unarchiveOriginal,
    peekPendingFiles: (sessionId: SessionId) => pendingFiles.get(sessionId),
    takePendingFiles(sessionId: SessionId) {
      const files = pendingFiles.get(sessionId)
      if (files !== undefined) clearPendingFiles(sessionId)
      return files
    },
  }
}

export type RewindController = ReturnType<typeof createRewindController>
