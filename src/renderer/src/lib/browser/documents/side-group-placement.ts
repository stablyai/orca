import { findSiblingGroupId } from '../../../../../shared/workspace-layout/tab-groups/tab-group-layout-tree'
import type { AppState } from '@/store/types'

/** The group a side preview targets: the source tab's group (or the active one) and its existing sibling, if any. */
export function sideGroupPlacement(
  state: AppState,
  worktreeId: string,
  sourceGroupIdParam: string | null
): { sourceGroupId: string; existingSibling: string | null } | null {
  // Use the originating tab’s group, falling back to the workspace’s active group.
  const sourceGroupId =
    sourceGroupIdParam ??
    state.activeGroupIdByWorktree[worktreeId] ??
    state.groupsByWorktree[worktreeId]?.[0]?.id ??
    null
  if (!sourceGroupId) {
    return null
  }
  const layout = state.layoutByWorktree[worktreeId] ?? null
  return {
    sourceGroupId,
    existingSibling: layout ? findSiblingGroupId(layout, sourceGroupId) : null
  }
}
