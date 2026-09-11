export const MANUAL_TERMINAL_WORKTREE_PARK_EVENT = 'orca-manual-terminal-worktree-park'

/** Why workspace-sleep is a distinct reason: sleep leaves the workspace in the terminal
 *  workbench's mounted set, so an ordinary unpark remount reattaches the sessions sleep killed,
 *  misses, and cold-restores them. Its park skips the on-demand eligibility gates, which a
 *  workspace with no surviving PTY can never satisfy. */
export type ManualTerminalWorktreeParkReason = 'manual' | 'workspace-sleep'

export type ManualTerminalWorktreeParkDetail = {
  worktreeId: string
  reason: ManualTerminalWorktreeParkReason
}

const pendingReasonsByWorktreeId = new Map<string, ManualTerminalWorktreeParkReason>()

export function requestManualTerminalWorktreePark(
  worktreeId: string,
  reason: ManualTerminalWorktreeParkReason = 'manual'
): void {
  if (!worktreeId) {
    return
  }
  pendingReasonsByWorktreeId.set(worktreeId, reason)
  window.dispatchEvent(
    new CustomEvent<ManualTerminalWorktreeParkDetail>(MANUAL_TERMINAL_WORKTREE_PARK_EVENT, {
      detail: { worktreeId, reason }
    })
  )
}

export function takePendingManualTerminalWorktreePark(
  worktreeId: string
): ManualTerminalWorktreeParkReason | null {
  const reason = pendingReasonsByWorktreeId.get(worktreeId) ?? null
  pendingReasonsByWorktreeId.delete(worktreeId)
  return reason
}

export function takeAllPendingManualTerminalWorktreeParks(): ManualTerminalWorktreeParkDetail[] {
  const pending = [...pendingReasonsByWorktreeId].map(([worktreeId, reason]) => ({
    worktreeId,
    reason
  }))
  pendingReasonsByWorktreeId.clear()
  return pending
}
