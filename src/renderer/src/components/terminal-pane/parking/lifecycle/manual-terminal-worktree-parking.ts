export const MANUAL_TERMINAL_WORKTREE_PARK_EVENT = 'orca-manual-terminal-worktree-park'

export type ManualTerminalWorktreeParkDetail = {
  worktreeId: string
}

const pendingWorktreeIds = new Set<string>()

export function requestManualTerminalWorktreePark(worktreeId: string): void {
  if (!worktreeId) {
    return
  }
  pendingWorktreeIds.add(worktreeId)
  window.dispatchEvent(
    new CustomEvent<ManualTerminalWorktreeParkDetail>(MANUAL_TERMINAL_WORKTREE_PARK_EVENT, {
      detail: { worktreeId }
    })
  )
}

export function takePendingManualTerminalWorktreePark(worktreeId: string): boolean {
  return pendingWorktreeIds.delete(worktreeId)
}

export function takeAllPendingManualTerminalWorktreeParks(): string[] {
  const pending = [...pendingWorktreeIds]
  pendingWorktreeIds.clear()
  return pending
}
