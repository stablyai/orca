import type { AppState } from '../../types'

/** The worktree's focused group when it is an empty split pane, which shows the split landing. */
export function findFocusedEmptySplitGroup(
  state: Pick<AppState, 'groupsByWorktree' | 'activeGroupIdByWorktree'>,
  worktreeId: string | null | undefined
): AppState['groupsByWorktree'][string][number] | null {
  if (!worktreeId) {
    return null
  }
  const groups = state.groupsByWorktree?.[worktreeId] ?? []
  const groupId = state.activeGroupIdByWorktree?.[worktreeId]
  const group = groups.find((candidate) => candidate.id === groupId)
  return group && groups.length > 1 && group.tabOrder.length === 0 ? group : null
}
