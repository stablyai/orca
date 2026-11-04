import type { AppState } from '../../types'

/** Stamps the group's active tab as just used, unless it already is the workspace's latest; null means no change. */
export function tabsWithUseRecorded(
  state: Pick<AppState, 'unifiedTabsByWorktree' | 'groupsByWorktree'>,
  worktreeId: string,
  groupId: string
): AppState['unifiedTabsByWorktree'] | null {
  const activeTabId = state.groupsByWorktree[worktreeId]?.find(
    (group) => group.id === groupId
  )?.activeTabId
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const used = tabs.find((tab) => tab.id === activeTabId)
  // Why: repeated clicks in the tab already in use must not rewrite the tab list.
  if (!used || tabs.every((tab) => (tab.lastFocusedAt ?? 0) <= (used.lastFocusedAt ?? 0))) {
    return null
  }
  const lastFocusedAt = Date.now()
  return {
    ...state.unifiedTabsByWorktree,
    [worktreeId]: tabs.map((tab) => (tab.id === used.id ? { ...tab, lastFocusedAt } : tab))
  }
}
