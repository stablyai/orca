import { useAppStore } from '../../store'
import type { TabSplitDirection } from '../../store/slices/tabs/tabs-slice-contract'
import { mirrorWebRuntimeTabMove } from './web-runtime-tab-move-mirror'
import {
  isDesktopCreatedTabInFrameDrawnServerWorkspace,
  serverTabCount
} from '@/lib/frame-drawn-desktop-created-tabs'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  dropTabThroughLayoutOwner,
  type TabDropCompletion
} from '../tab-group/tab-group-layout-owner-commands'

type TabMovePaneColumnState = Pick<
  ReturnType<typeof useAppStore.getState>,
  'unifiedTabsByWorktree' | 'groupsByWorktree'
>

function canMoveTabToNewPaneColumnFromState(
  state: TabMovePaneColumnState,
  unifiedTabId: string,
  groupId: string,
  knownWorktreeId?: string
): boolean {
  const workspaces = knownWorktreeId
    ? [[knownWorktreeId, state.unifiedTabsByWorktree[knownWorktreeId] ?? []] as const]
    : Object.entries(state.unifiedTabsByWorktree)
  for (const [worktreeId, tabs] of workspaces) {
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
  /** The tab's workspace, when the caller knows it. */
  worktreeId?: string
  unifiedTabId: string
  groupId: string
  direction: TabSplitDirection
  completion?: TabDropCompletion
}): 'owner' | 'moved' | false {
  const state = useAppStore.getState()
  const worktreeId =
    args.worktreeId ??
    Object.entries(state.unifiedTabsByWorktree).find(([, tabs]) =>
      tabs.some(
        (candidate) => candidate.id === args.unifiedTabId && candidate.groupId === args.groupId
      )
    )?.[0]
  if (
    !worktreeId ||
    !canMoveTabToNewPaneColumnFromState(state, args.unifiedTabId, args.groupId, worktreeId)
  ) {
    return false
  }
  if (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    dropTabThroughLayoutOwner(
      worktreeId,
      {
        kind: 'split',
        tabId: args.unifiedTabId,
        groupId: args.groupId,
        direction: args.direction
      },
      args.completion
    )
  ) {
    return 'owner'
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
  return moved ? 'moved' : false
}

/** Moves a tab into another pane as dropping it there does: main draws it ('owner'), or this window
 *  moves it and tells a paired host ('moved'); false when nothing moved. */
export function moveTabToGroup(
  args: { worktreeId: string; unifiedTabId: string; groupId: string; index?: number },
  dropUnifiedTab = useAppStore.getState().dropUnifiedTab,
  completion?: TabDropCompletion
): 'owner' | 'moved' | false {
  const { worktreeId, unifiedTabId, groupId, index } = args
  const at = index === undefined ? {} : { index }
  if (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    dropTabThroughLayoutOwner(
      worktreeId,
      { kind: 'move', tabId: unifiedTabId, groupId, ...at },
      completion
    )
  ) {
    return 'owner'
  }
  if (!dropUnifiedTab(unifiedTabId, { groupId, ...at })) {
    return false
  }
  mirrorWebRuntimeTabMove({
    kind: 'move-to-group',
    worktreeId,
    tabId: unifiedTabId,
    targetGroupId: groupId,
    ...at
  })
  return 'moved'
}
