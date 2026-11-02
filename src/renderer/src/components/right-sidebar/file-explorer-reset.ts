import type { RightSidebarExplorerView } from '../../../../shared/ui-chrome-types'

export function getVisibleFileExplorerWorktreePath({
  explorerView,
  rightSidebarOpen,
  worktreePath
}: {
  explorerView: RightSidebarExplorerView
  rightSidebarOpen: boolean
  worktreePath: string | null
}): string | null {
  // Contents search leaves Files mounted; suppress hidden tree loads and macOS app-data probes.
  return rightSidebarOpen && explorerView === 'files' ? worktreePath : null
}

export function shouldResetFileExplorerForVisibleWorktree(
  lastResetWorktreePath: string | null,
  visibleWorktreePath: string | null
): visibleWorktreePath is string {
  return visibleWorktreePath !== null && lastResetWorktreePath !== visibleWorktreePath
}
