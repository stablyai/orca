import { getTerminalNoticeLifetime } from '@/components/terminal-pane/provider-notices/terminal-notice-lifetime'
import { createCodexAccountRestartActions } from '../codex-account-restart-actions'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import {
  isCodexAccountRestart,
  currentCodexAccountRestart,
  currentCodexRestartPanes
} from '../codex-account-restart-continuation'
import type { PaneAccountRestart, AccountRestartAgent } from '../terminal-contracts'
import { isSameCodexRestartNoticeAccount } from './codex-restart-notice-account-identity'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from '../terminal-state'

// Why: Codex notice cleanup shares this map with Claude switch restarts and must not drop them.
function dropQueuedCodexRestart(
  pending: Record<string, PaneAccountRestart>,
  ptyIds: ReadonlySet<string>,
  cancelUndispatched = false
): void {
  for (const ptyId of ptyIds) {
    if (pending[ptyId] === 'codex') {
      delete pending[ptyId]
    }
  }
  if (!cancelUndispatched) {
    return
  }
  for (const [key, request] of Object.entries(pending)) {
    if (
      isCodexAccountRestart(request) &&
      ptyIds.has(request.oldPtyId) &&
      ['accepted', 'claimed', 'deferred'].includes(request.phase)
    ) {
      delete pending[key]
    }
  }
}

export function createTerminalRestartActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<
  TerminalSlice,
  | 'consumeSuppressedPtyExit'
  | 'isPtyShutdownPending'
  | 'suppressPtyExit'
  | 'queuePaneAccountRestarts'
  | 'consumePendingPaneAccountRestart'
  | 'claimCodexAccountRestart'
  | 'updateCodexAccountRestart'
  | 'retryCodexAccountRestart'
  | 'markCodexRestartNotices'
  | 'clearCodexRestartNotice'
  | 'retireCodexRestartEndpoint'
  | 'dismissCodexRestartNotices'
  | 'reopenCodexRestartPrompt'
> {
  const { queueCodexAccountRestarts, ...codexActions } = createCodexAccountRestartActions(set, get)
  return {
    consumeSuppressedPtyExit: (ptyId) => {
      let wasSuppressed = false
      set((s) => {
        if (!s.suppressedPtyExitIds[ptyId]) {
          return s
        }
        wasSuppressed = true
        const next = { ...s.suppressedPtyExitIds }
        delete next[ptyId]
        return { suppressedPtyExitIds: next }
      })
      return wasSuppressed
    },
    isPtyShutdownPending: (ptyId) => (get().pendingPtyShutdownIds[ptyId] ?? 0) > 0,
    suppressPtyExit: (ptyId) => {
      set((s) => ({
        suppressedPtyExitIds: { ...s.suppressedPtyExitIds, [ptyId]: true }
      }))
    },
    ...codexActions,
    queuePaneAccountRestarts: (ptyIds, agent) => {
      if (agent === 'codex') {
        queueCodexAccountRestarts(ptyIds)
        return
      }
      if (ptyIds.length === 0) {
        return
      }
      set((state) => ({
        paneAccountRestarts: {
          ...state.paneAccountRestarts,
          ...Object.fromEntries(ptyIds.map((id) => [id, 'claude' as const]))
        }
      }))
    },
    consumePendingPaneAccountRestart: (ptyId) => {
      if (get().paneAccountRestarts[ptyId] === 'codex') {
        get().reopenCodexRestartPrompt(ptyId)
      }
      let queuedAgent: AccountRestartAgent | null = null
      set((s) => {
        const agent = s.paneAccountRestarts[ptyId]
        if (!agent) {
          return s
        }
        if (typeof agent !== 'string') {
          return s
        }
        queuedAgent = agent === 'claude' ? agent : null
        const next = { ...s.paneAccountRestarts }
        delete next[ptyId]
        return { paneAccountRestarts: next }
      })
      return queuedAgent
    },
    markCodexRestartNotices: (notices) => {
      if (notices.length === 0) {
        return []
      }
      const noticedPtyIds: string[] = []
      set((s) => {
        const next = { ...s.codexRestartNoticeByPtyId }
        const nextPendingPaneAccountRestarts = { ...s.paneAccountRestarts }
        const eligible = currentCodexRestartPanes(s)
        const cancelled = new Set<string>()
        for (const notice of notices) {
          const pane = eligible.get(notice.ptyId)
          if (!pane) {
            continue
          }
          if (
            notice.origin &&
            (notice.origin.key !== pane.key ||
              notice.origin.tabCreatedAt !== pane.tabCreatedAt ||
              notice.origin.hostId !== getExecutionHostIdForWorktree(s, pane.worktreeId) ||
              notice.origin.lifetime !== getTerminalNoticeLifetime(notice.ptyId))
          ) {
            continue
          }
          const incarnation = getTerminalNoticeLifetime(notice.ptyId)?.incarnationId
          if (incarnation && notice.incarnationId && incarnation !== notice.incarnationId) {
            continue
          }
          const existing = next[notice.ptyId]
          // Read launch account ID/label from one source or they can describe different accounts.
          const launch = existing ?? notice
          const target = { id: notice.nextAccountId, label: notice.nextAccountLabel }
          // Why: a live Codex pane keeps its original launch account until it actually restarts, so A -> B -> A must not leave a stale restart notice.
          if (
            isSameCodexRestartNoticeAccount(
              { id: launch.previousAccountId, label: launch.previousAccountLabel },
              target
            )
          ) {
            delete next[notice.ptyId]
            cancelled.add(notice.ptyId)
            continue
          }
          next[notice.ptyId] = {
            ...(notice.incarnationId || incarnation
              ? { incarnationId: notice.incarnationId ?? incarnation }
              : {}),
            previousAccountLabel: launch.previousAccountLabel,
            nextAccountLabel: notice.nextAccountLabel,
            ...(launch.previousAccountId === undefined
              ? {}
              : { previousAccountId: launch.previousAccountId }),
            ...(notice.nextAccountId === undefined ? {} : { nextAccountId: notice.nextAccountId }),
            // Why: a queued restart relaunches under whatever account is selected
            // when it runs, so a later switch does not reopen an answered prompt.
            ...(existing?.restartRequested ? { restartRequested: true as const } : {}),
            // Dismissal covers one target account; re-ask only on target change, never same-account add/reauth that would reblock input.
            ...(existing?.dismissed &&
            isSameCodexRestartNoticeAccount(
              { id: existing.nextAccountId, label: existing.nextAccountLabel },
              target
            )
              ? { dismissed: true as const }
              : {})
          }
          noticedPtyIds.push(notice.ptyId)
        }
        dropQueuedCodexRestart(nextPendingPaneAccountRestarts, cancelled, true)
        return {
          codexRestartNoticeByPtyId: next,
          paneAccountRestarts: nextPendingPaneAccountRestarts
        }
      })
      return noticedPtyIds
    },
    retireCodexRestartEndpoint: (ptyId, incarnationId, currentAttempt) => {
      set((s) => {
        let notices = s.codexRestartNoticeByPtyId
        let requests = s.paneAccountRestarts
        const notice = notices[ptyId]
        if (notice?.incarnationId && notice.incarnationId !== incarnationId) {
          notices = { ...notices }
          delete notices[ptyId]
        }
        for (const [key, request] of Object.entries(requests)) {
          if (!isCodexAccountRestart(request) || request.oldPtyId !== ptyId) {
            continue
          }
          if (currentAttempt && currentCodexAccountRestart(s, currentAttempt) === request) {
            continue
          }
          const oldIncarnation =
            request.oldIncarnationId ??
            (request.condition?.expected.kind === 'endpoint'
              ? request.condition.expected.incarnationId
              : undefined)
          if (!oldIncarnation || oldIncarnation === incarnationId) {
            continue
          }
          if (requests === s.paneAccountRestarts) {
            requests = { ...requests }
          }
          delete requests[key]
        }
        return notices === s.codexRestartNoticeByPtyId && requests === s.paneAccountRestarts
          ? s
          : { codexRestartNoticeByPtyId: notices, paneAccountRestarts: requests }
      })
    },
    clearCodexRestartNotice: (ptyId) => {
      set((s) => {
        if (!s.codexRestartNoticeByPtyId[ptyId]) {
          return s
        }
        const next = { ...s.codexRestartNoticeByPtyId }
        const nextPendingPaneAccountRestarts = { ...s.paneAccountRestarts }
        delete next[ptyId]
        dropQueuedCodexRestart(nextPendingPaneAccountRestarts, new Set([ptyId]))
        return {
          codexRestartNoticeByPtyId: next,
          paneAccountRestarts: nextPendingPaneAccountRestarts
        }
      })
    },
    dismissCodexRestartNotices: (ptyIds) => {
      set((s) => {
        // Dismissal keeps launch-account provenance but answers prompt/frees input without scheduling restart.
        const next = { ...s.codexRestartNoticeByPtyId }
        const nextPendingPaneAccountRestarts = { ...s.paneAccountRestarts }
        const cancelled = new Set<string>()
        let changed = false
        for (const ptyId of ptyIds) {
          const notice = next[ptyId]
          if (!notice || notice.dismissed) {
            continue
          }
          const { restartRequested: _restartRequested, ...kept } = notice
          next[ptyId] = { ...kept, dismissed: true }
          cancelled.add(ptyId)
          changed = true
        }
        if (!changed) {
          return s
        }
        dropQueuedCodexRestart(nextPendingPaneAccountRestarts, cancelled, true)
        return {
          codexRestartNoticeByPtyId: next,
          paneAccountRestarts: nextPendingPaneAccountRestarts
        }
      })
    },
    reopenCodexRestartPrompt: (ptyId) => {
      set((s) => {
        const notice = s.codexRestartNoticeByPtyId[ptyId]
        if (!notice?.restartRequested) {
          return s
        }
        const { restartRequested: _restartRequested, ...kept } = notice
        const nextPendingPaneAccountRestarts = { ...s.paneAccountRestarts }
        dropQueuedCodexRestart(nextPendingPaneAccountRestarts, new Set([ptyId]))
        return {
          codexRestartNoticeByPtyId: { ...s.codexRestartNoticeByPtyId, [ptyId]: kept },
          paneAccountRestarts: nextPendingPaneAccountRestarts
        }
      })
    }
  }
}
