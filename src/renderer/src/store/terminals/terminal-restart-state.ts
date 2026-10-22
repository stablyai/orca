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
        // Why: the prompt is answered the moment the user asks for a restart. A
        // pane whose tab isn't mounted can only restart when it next mounts, and
        // leaving the prompt up re-showed a button that now does nothing.
        const nextCodexRestartNoticeByPtyId = { ...s.codexRestartNoticeByPtyId }
        for (const ptyId of ptyIds) {
          const notice = nextCodexRestartNoticeByPtyId[ptyId]
          if (notice) {
            // Why: mirror of the strip in dismissCodexRestartNotices. A queued
            // restart leaves the pane on the old account until it relaunches, so
            // it must re-block input that an earlier dismissal had freed.
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
          // Why one record rather than two lookups: the label and the id of the
          // launch account have to come from the same source, or they can end up
          // describing two different accounts.
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
            // Why: a dismissal answered one question — "keep the launch account
            // instead of this one". Only a genuinely different target re-asks it,
            // so a later C reopens the prompt while adding an account or
            // reauthenticating the active one (both re-mark live panes with the
            // selection unchanged) must not resurrect it and re-mute the pane.
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
        // Why: keeping the old account is an answer, not a restart — the record
        // stays so `previousAccountLabel` still names the pane's launch account,
        // but every consumer treats it as answered (prompt hidden, input freed).
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
