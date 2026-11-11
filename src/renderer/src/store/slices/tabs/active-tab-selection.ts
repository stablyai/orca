import type { Tab, TabGroup } from '../../../../../shared/tab-types'

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
