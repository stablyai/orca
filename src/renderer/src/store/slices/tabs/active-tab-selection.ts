import type { Tab, TabGroup } from '../../../../../shared/workspace-layout/tab-groups/tab-types'

/** The active group's active tab in a worktree. */
export function selectActiveTabForWorktree(
  state: {
    activeGroupIdByWorktree: Record<string, string>
    groupsByWorktree: Record<string, TabGroup[]>
    unifiedTabsByWorktree: Record<string, Tab[]>
  },
  worktreeId: string
): Tab | null {
  const groupId = state.activeGroupIdByWorktree[worktreeId]
  const group = (state.groupsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === groupId
  )
  if (!group?.activeTabId) {
    return null
  }
  return (
    (state.unifiedTabsByWorktree[worktreeId] ?? []).find((tab) => tab.id === group.activeTabId) ??
    null
  )
}

/** The tab in front of the window: the active workspace's, while its tabs are the view. */
export function selectFrontTab(state: {
  activeView: string
  activeWorkspaceKey: string | null
  activeWorktreeId: string | null
  activeGroupIdByWorktree: Record<string, string>
  groupsByWorktree: Record<string, TabGroup[]>
  unifiedTabsByWorktree: Record<string, Tab[]>
}): Tab | null {
  const workspaceId = state.activeWorkspaceKey ?? state.activeWorktreeId
  return workspaceId && state.activeView === 'terminal'
    ? selectActiveTabForWorktree(state, workspaceId)
    : null
}
