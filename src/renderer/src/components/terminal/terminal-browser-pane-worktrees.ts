import type { WorkspaceVisibleTabType } from '../../../../shared/types'

export type TerminalBrowserPaneWorktreeInput = {
  mountedWorktreeIds: string[]
  worktreeIds: string[]
  activeWorktreeId: string | null
  activeTabType: WorkspaceVisibleTabType
  activeBrowserTabCount: number
}

export function getTerminalBrowserPaneWorktreeIds({
  mountedWorktreeIds,
  worktreeIds,
  activeWorktreeId,
  activeTabType,
  activeBrowserTabCount
}: TerminalBrowserPaneWorktreeInput): string[] {
  if (
    activeWorktreeId === null ||
    activeTabType !== 'browser' ||
    activeBrowserTabCount === 0 ||
    mountedWorktreeIds.includes(activeWorktreeId) ||
    !worktreeIds.includes(activeWorktreeId)
  ) {
    return mountedWorktreeIds
  }

  // Why: BrowserPane does not spawn PTYs. Keep a restored active browser
  // visible while TerminalPane mounts still wait for reconnect to finish.
  return [...mountedWorktreeIds, activeWorktreeId]
}
