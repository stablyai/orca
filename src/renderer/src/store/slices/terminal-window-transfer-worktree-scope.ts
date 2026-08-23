import type { AppState } from '../types'

export function transferredTerminalWorktreeIds(
  state: AppState,
  tabId: string,
  ...additionalStates: AppState[]
): Set<string> {
  const worktreeIds = new Set<string>()
  for (const candidate of [state, ...additionalStates]) {
    for (const [worktreeId, tabs] of Object.entries(candidate.tabsByWorktree)) {
      if (tabs.some(({ id }) => id === tabId)) {
        worktreeIds.add(worktreeId)
      }
    }
    for (const [worktreeId, tabs] of Object.entries(candidate.unifiedTabsByWorktree)) {
      if (
        tabs.some(({ entityId, contentType }) => entityId === tabId && contentType === 'terminal')
      ) {
        worktreeIds.add(worktreeId)
      }
    }
    for (const [worktreeId, groups] of Object.entries(candidate.groupsByWorktree)) {
      if (groups.some(({ tabOrder }) => tabOrder.includes(tabId))) {
        worktreeIds.add(worktreeId)
      }
    }
    for (const [worktreeId, tabOrder] of Object.entries(candidate.tabBarOrderByWorktree)) {
      if (tabOrder.includes(tabId)) {
        worktreeIds.add(worktreeId)
      }
    }
  }
  return worktreeIds
}
