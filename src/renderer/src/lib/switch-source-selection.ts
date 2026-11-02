import type { AppState } from '@/store/types'

/** A switch moves the selection only while its source tab still holds it in its group: a user
 *  who picked another tab there keeps that choice. A tab no group lists is no proof the user
 *  stayed on it. */
export function sourceTabHoldsSelection(
  state: Pick<AppState, 'groupsByWorktree'>,
  worktreeId: string,
  tab: { id: string; groupId: string }
): boolean {
  const group = state.groupsByWorktree[worktreeId]?.find((entry) => entry.id === tab.groupId)
  return group !== undefined && (group.activeTabId == null || group.activeTabId === tab.id)
}

/** Whether the user is looking at this group now: it is the active group of their workspace. */
export function sourceTabGroupInView(
  state: Pick<AppState, 'activeWorktreeId' | 'activeGroupIdByWorktree'>,
  worktreeId: string,
  groupId: string
): boolean {
  return (
    state.activeWorktreeId === worktreeId &&
    (state.activeGroupIdByWorktree[worktreeId] ?? groupId) === groupId
  )
}
