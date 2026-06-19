import type { RightSidebarExplorerView } from '../../../../shared/types'

export function getVisibleFileExplorerWorktreePath({
  explorerView,
  rightSidebarOpen,
  worktreePath
}: {
  explorerView: RightSidebarExplorerView
  rightSidebarOpen: boolean
  worktreePath: string | null
}): string | null {
  // Why: Contents search keeps the file pane mounted, but hidden file trees
  // must not trigger passive file loads or macOS app-data probes.
  return rightSidebarOpen && explorerView === 'files' ? worktreePath : null
}

export function shouldResetFileExplorerForVisibleWorktree(
  lastResetWorktreePath: string | null,
  visibleWorktreePath: string | null
): visibleWorktreePath is string {
  return visibleWorktreePath !== null && lastResetWorktreePath !== visibleWorktreePath
}
