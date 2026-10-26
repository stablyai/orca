import { isSameCodexRestartNoticeAccount } from '../slices/codex-restart-notice-account-identity'
import type { AccountRestartAgent } from './terminal-contracts'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'

// Why: Codex notice cleanup shares this map with Claude switch restarts and must not drop them.
function dropQueuedCodexRestart(pending: Record<string, AccountRestartAgent>, ptyId: string): void {
  if (pending[ptyId] === 'codex') {
    delete pending[ptyId]
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
  | 'markCodexRestartNotices'
  | 'clearCodexRestartNotice'
  | 'dismissCodexRestartNotices'
  | 'reopenCodexRestartPrompt'
> {
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
    queuePaneAccountRestarts: (ptyIds, agent) => {
      if (ptyIds.length === 0) {
        return
      }
      set((s) => {
        const pendingPaneAccountRestarts = {
          ...s.pendingPaneAccountRestarts,
          ...Object.fromEntries(ptyIds.map((ptyId) => [ptyId, agent] as const))
        }
        if (agent === 'claude') {
          return { pendingPaneAccountRestarts }
        }
        // Restart request answers the prompt immediately; unmounted tabs wait for mount and must not show an inert restart button.
        const nextCodexRestartNoticeByPtyId = { ...s.codexRestartNoticeByPtyId }
        for (const ptyId of ptyIds) {
          const notice = nextCodexRestartNoticeByPtyId[ptyId]
          if (notice) {
            // Queued restart must remove dismissal’s input exemption while the pane still runs on the old account.
            const { dismissed: _dismissed, ...kept } = notice
            nextCodexRestartNoticeByPtyId[ptyId] = { ...kept, restartRequested: true }
          }
        }
        return {
          pendingPaneAccountRestarts,
          codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId
        }
      })
    },
    consumePendingPaneAccountRestart: (ptyId) => {
      let queuedAgent: AccountRestartAgent | null = null
      set((s) => {
        const agent = s.pendingPaneAccountRestarts[ptyId]
        if (!agent) {
          return s
        }
        queuedAgent = agent
        const next = { ...s.pendingPaneAccountRestarts }
        delete next[ptyId]
        return { pendingPaneAccountRestarts: next }
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
        const nextPendingPaneAccountRestarts = { ...s.pendingPaneAccountRestarts }
        for (const notice of notices) {
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
            dropQueuedCodexRestart(nextPendingPaneAccountRestarts, notice.ptyId)
            continue
          }
          next[notice.ptyId] = {
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
        return {
          codexRestartNoticeByPtyId: next,
          pendingPaneAccountRestarts: nextPendingPaneAccountRestarts
        }
      })
      return noticedPtyIds
    },
    clearCodexRestartNotice: (ptyId) => {
      set((s) => {
        if (!s.codexRestartNoticeByPtyId[ptyId]) {
          return s
        }
        const next = { ...s.codexRestartNoticeByPtyId }
        const nextPendingPaneAccountRestarts = { ...s.pendingPaneAccountRestarts }
        delete next[ptyId]
        dropQueuedCodexRestart(nextPendingPaneAccountRestarts, ptyId)
        return {
          codexRestartNoticeByPtyId: next,
          pendingPaneAccountRestarts: nextPendingPaneAccountRestarts
        }
      })
    },
    dismissCodexRestartNotices: (ptyIds) => {
      set((s) => {
        // Dismissal keeps launch-account provenance but answers prompt/frees input without scheduling restart.
        const next = { ...s.codexRestartNoticeByPtyId }
        const nextPendingPaneAccountRestarts = { ...s.pendingPaneAccountRestarts }
        let changed = false
        for (const ptyId of ptyIds) {
          const notice = next[ptyId]
          if (!notice || notice.dismissed) {
            continue
          }
          const { restartRequested: _restartRequested, ...kept } = notice
          next[ptyId] = { ...kept, dismissed: true }
          dropQueuedCodexRestart(nextPendingPaneAccountRestarts, ptyId)
          changed = true
        }
        if (!changed) {
          return s
        }
        return {
          codexRestartNoticeByPtyId: next,
          pendingPaneAccountRestarts: nextPendingPaneAccountRestarts
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
        const nextPendingPaneAccountRestarts = { ...s.pendingPaneAccountRestarts }
        dropQueuedCodexRestart(nextPendingPaneAccountRestarts, ptyId)
        return {
          codexRestartNoticeByPtyId: { ...s.codexRestartNoticeByPtyId, [ptyId]: kept },
          pendingPaneAccountRestarts: nextPendingPaneAccountRestarts
        }
      })
    }
  }
}
