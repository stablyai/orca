import type { NewGroupSplit } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { newGroupSplitOf } from './layout-owner-new-group-split'

type DrawnTabPlacement = {
  groupId: string
  afterTabId?: string
  index?: 0
  split?: NewGroupSplit
}

/**
 * Where the window drew a just-opened tab, as an open command's placement fields: after the tab
 * before it, first in its group, or (missing from the order) only the group; plus the split that
 * made its group when it was opened to the side.
 */
export function drawnTabPlacement(
  state: Parameters<typeof newGroupSplitOf>[0],
  worktreeId: string,
  groupId: string,
  tabId: string
): DrawnTabPlacement {
  const order = state.groupsByWorktree[worktreeId]?.find((group) => group.id === groupId)?.tabOrder
  const position = order?.indexOf(tabId) ?? -1
  const afterTabId = position > 0 ? order?.[position - 1] : undefined
  return {
    groupId,
    ...(afterTabId ? { afterTabId } : position === 0 ? { index: 0 } : {}),
    ...newGroupSplitOf(state, worktreeId, groupId, tabId)
  }
}
