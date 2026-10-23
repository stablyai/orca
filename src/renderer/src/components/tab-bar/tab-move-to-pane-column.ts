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
    // Why: mirror dropUnifiedTab — splitting the only tab in a group onto an
    // adjacent split pane is a layout no-op the store rejects. A tab this desktop created never
    // splits off, and counts for nothing: the server's group lacks it.
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
  // Switch point: main places the tab beside its group first.
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
