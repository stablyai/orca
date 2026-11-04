import { useAppStore } from '../../store'
import type { TabSplitDirection } from '../../store/slices/tabs'
import { mirrorWebRuntimeTabMove } from './web-runtime-tab-move-mirror'
import {
  isDesktopCreatedTabInFrameDrawnServerWorkspace,
  serverTabCount
} from '@/lib/frame-drawn-desktop-created-tabs'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { dropTabThroughLayoutOwner } from '../tab-group/tab-group-layout-owner-commands'

type TabMovePaneColumnState = Pick<
  ReturnType<typeof useAppStore.getState>,
  'unifiedTabsByWorktree' | 'groupsByWorktree'
>

function canMoveTabToNewPaneColumnFromState(
  state: TabMovePaneColumnState,
  unifiedTabId: string,
  groupId: string
): boolean {
  for (const [worktreeId, tabs] of Object.entries(state.unifiedTabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === unifiedTabId)
    if (!tab || tab.groupId !== groupId) {
      continue
    }
    const group = (state.groupsByWorktree[worktreeId] ?? []).find(
      (candidate) => candidate.id === groupId
    )
    if (!group) {
      return false
    }
    // A group needs two server-owned tabs to split; desktop-only tabs cannot populate the server’s new group.
    return (
      !isDesktopCreatedTabInFrameDrawnServerWorkspace(worktreeId, unifiedTabId) &&
      serverTabCount(worktreeId, group.tabOrder) > 1
    )
  }
  return false
}

export function canMoveTabToNewPaneColumn(unifiedTabId: string, groupId: string): boolean {
  return canMoveTabToNewPaneColumnFromState(useAppStore.getState(), unifiedTabId, groupId)
}

export function moveTabToNewPaneColumn(args: {
  unifiedTabId: string
  groupId: string
  direction: TabSplitDirection
}): boolean {
  const state = useAppStore.getState()
  const worktreeId = Object.entries(state.unifiedTabsByWorktree).find(([, tabs]) =>
    tabs.some(
      (candidate) => candidate.id === args.unifiedTabId && candidate.groupId === args.groupId
    )
  )?.[0]
  if (!worktreeId || !canMoveTabToNewPaneColumnFromState(state, args.unifiedTabId, args.groupId)) {
    return false
  }
  if (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    dropTabThroughLayoutOwner(worktreeId, {
      kind: 'split',
      tabId: args.unifiedTabId,
      groupId: args.groupId,
      direction: args.direction
    })
  ) {
    return true
  }
  const moved = state.dropUnifiedTab(args.unifiedTabId, {
    groupId: args.groupId,
    splitDirection: args.direction
  })
  if (moved) {
    mirrorWebRuntimeTabMove({
      kind: 'split',
      worktreeId,
      tabId: args.unifiedTabId,
      targetGroupId: args.groupId,
      splitDirection: args.direction
    })
  }
  return moved
}
