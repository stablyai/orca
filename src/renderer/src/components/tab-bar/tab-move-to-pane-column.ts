import { useAppStore } from '../../store'
import type { TabSplitDirection } from '../../store/slices/tabs'
import type { TabGroupLayoutNode } from '../../../../shared/tab-types'
import { mirrorWebRuntimeTabMove } from './web-runtime-tab-move-mirror'

type TabMovePaneColumnState = Pick<
  ReturnType<typeof useAppStore.getState>,
  'unifiedTabsByWorktree' | 'groupsByWorktree'
>

export function canMoveTabToNewPaneColumnFromState(
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
    // adjacent split pane is a layout no-op the store rejects.
    return group.tabOrder.length > 1
  }
  return false
}

export function canMoveTabToNewPaneColumn(unifiedTabId: string, groupId: string): boolean {
  return canMoveTabToNewPaneColumnFromState(useAppStore.getState(), unifiedTabId, groupId)
}

function flattenLayoutLeaves(node: TabGroupLayoutNode | undefined): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.groupId]
  }
  return [...flattenLayoutLeaves(node.first), ...flattenLayoutLeaves(node.second)]
}

/**
 * Moves the active tab of the active group to the next pane column, mirroring VS Code's
 * "move editor to next group": join the existing next group when there is one (the emptied
 * source group collapses), otherwise split the tab off into a new column. Returns whether a
 * move happened so keybinding callers can fall through instead of consuming the chord on a
 * no-op.
 */
export function moveActiveTabToNextPaneColumn(direction: TabSplitDirection): boolean {
  const state = useAppStore.getState()
  const worktreeId = state.activeWorktreeId
  if (!worktreeId) {
    return false
  }
  const leaves = flattenLayoutLeaves(state.layoutByWorktree[worktreeId])
  // Why: activeGroupIdByWorktree is only populated once a group interaction happened;
  // a fresh single-group window has no entry, so fall back to the layout's first leaf.
  const groupId =
    state.activeGroupIdByWorktree[worktreeId] ??
    leaves[0] ??
    (state.groupsByWorktree[worktreeId] ?? [])[0]?.id
  if (!groupId) {
    return false
  }
  const group = (state.groupsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === groupId
  )
  const unifiedTabId = group?.activeTabId
  if (!unifiedTabId) {
    return false
  }
  const activeLeafIndex = leaves.indexOf(groupId)
  const nextGroupId = activeLeafIndex === -1 ? undefined : leaves[activeLeafIndex + 1]
  if (nextGroupId) {
    const moved = state.moveUnifiedTabToGroup(unifiedTabId, nextGroupId, { activate: true })
    if (moved) {
      // Why: VS Code focuses the target group after the move; without this the source group keeps focus when it still has tabs.
      useAppStore.getState().focusGroup(worktreeId, nextGroupId)
      mirrorWebRuntimeTabMove({
        kind: 'move-to-group',
        worktreeId,
        tabId: unifiedTabId,
        targetGroupId: nextGroupId
      })
    }
    return moved
  }
  return moveTabToNewPaneColumn({ unifiedTabId, groupId, direction })
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
