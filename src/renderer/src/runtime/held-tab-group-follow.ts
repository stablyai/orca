// If main removes a user-only side group containing their held tab, follow the tab into main’s resulting group.

import type { AppState } from '@/store/types'
import type { HeldDrawnTabs } from '@/store/workspace-layout-frame-held-tabs'

type FollowState = Pick<
  AppState,
  'unifiedTabsByWorktree' | 'groupsByWorktree' | 'activeGroupIdByWorktree'
>

/** Each workspace in `keys` whose user group the build removed, with the group to focus. */
function heldTabGroupFollows(
  before: FollowState,
  after: FollowState,
  keys: readonly string[],
  held: HeldDrawnTabs
): { worktreeId: string; groupId: string }[] {
  return keys.flatMap((worktreeId) => {
    const userGroupId = before.activeGroupIdByWorktree[worktreeId]
    const groups = after.groupsByWorktree[worktreeId] ?? []
    if (!userGroupId || groups.some((group) => group.id === userGroupId)) {
      return []
    }
    const tabId = (before.groupsByWorktree[worktreeId] ?? []).find(
      (group) => group.id === userGroupId
    )?.activeTabId
    if (!tabId || !held.keepsInMainGroups?.(worktreeId, tabId)) {
      return []
    }
    const groupId = after.unifiedTabsByWorktree[worktreeId]?.find(
      (tab) => tab.id === tabId
    )?.groupId
    return groupId && groupId !== after.activeGroupIdByWorktree[worktreeId]
      ? [{ worktreeId, groupId }]
      : []
  })
}

/** Focuses, when called, the groups the user follows their held tabs into after a build. */
export function heldTabGroupFocus(
  before: FollowState,
  store: { getState: () => AppState },
  keys: readonly string[],
  held: HeldDrawnTabs
): () => void {
  const follows = heldTabGroupFollows(before, store.getState(), keys, held)
  return () => {
    for (const { worktreeId, groupId } of follows) {
      store.getState().focusGroup(worktreeId, groupId)
    }
  }
}
