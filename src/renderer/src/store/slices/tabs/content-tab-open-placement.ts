// Resolve placement like create: requested live group, anchor, active, then first/root; side opens carry their split, including window-only empty groups.

import { createBrowserUuid } from '@/lib/browser-uuid'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { folderWorkspaceToWorktree } from '../../../../../shared/folder-workspace-worktree'
import type { NewGroupSplit } from '../../../../../shared/workspace-layout/workspace-layout-command-types'
import type { AppState } from '../../types'
import { newGroupSplitOf } from '@/runtime/layout-owner-new-group-split'
import { selectFolderWorkspaces } from '../../workspace-record-selectors'
import { resolveUnifiedTabCreatePlacement } from './tabs-create-placement'
import type { TabSplitTarget } from './tabs-slice-contract'

export type ContentTabOpenPlacement = {
  groupId: string
  afterTabId?: string
  split?: NewGroupSplit
}

export function contentTabOpenPlacement(
  state: AppState,
  worktreeId: string,
  tabId: string,
  request: {
    targetGroupId?: string
    afterTabId?: string
    split?: TabSplitTarget
    executionHostId?: ExecutionHostId
  }
): ContentTabOpenPlacement | null {
  if (request.split) {
    return {
      groupId: createBrowserUuid(),
      split: { besideGroupId: request.split.sourceGroupId, direction: request.split.splitDirection }
    }
  }
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const placement = resolveUnifiedTabCreatePlacement({
    groups,
    tabs: state.unifiedTabsByWorktree[worktreeId] ?? [],
    activeGroupId: state.activeGroupIdByWorktree[worktreeId],
    targetGroupId: request.targetGroupId,
    afterTabId: request.afterTabId,
    executionHostId: request.executionHostId,
    lookupWorktrees: () =>
      [
        ...(state.allWorktrees?.() ?? []),
        ...(selectFolderWorkspaces(state) ?? []).map(folderWorkspaceToWorktree)
      ].filter((worktree) => worktree.id === worktreeId)
  })
  const groupId = placement.groupId ?? groups[0]?.id ?? state.ensureWorktreeRootGroup?.(worktreeId)
  if (!groupId) {
    return null
  }
  return {
    groupId,
    ...(placement.anchorTabId ? { afterTabId: placement.anchorTabId } : {}),
    ...newGroupSplitOf(state, worktreeId, groupId, tabId)
  }
}
