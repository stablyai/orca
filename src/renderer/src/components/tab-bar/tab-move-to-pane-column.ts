import { useAppStore } from '../../store'
import type { TabSplitDirection } from '../../store/slices/tabs'
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

/**
 * Resolve the tab a keyboard-driven move should act on: the active tab of the
 * active group in the given worktree.
 *
 * The context menu knows its own tab; a shortcut has to find one, and the
 * active group is the only tab the user can see they are acting on.
 *
 * @param state Store slice carrying group state for the worktree.
 * @param worktreeId The worktree whose active tab should move.
 * @returns The tab and its group, or null when the worktree has no active tab.
 */
export function getActiveTabForPaneColumnMove(
  state: TabMovePaneColumnState & { activeGroupIdByWorktree: Record<string, string> },
  worktreeId: string | null | undefined
): { unifiedTabId: string; groupId: string } | null {
  if (!worktreeId) {
    return null
  }
  const groupId = state.activeGroupIdByWorktree[worktreeId]
  if (!groupId) {
    return null
  }
  const group = (state.groupsByWorktree[worktreeId] ?? []).find(
    (candidate) => candidate.id === groupId
  )
  const unifiedTabId = group?.activeTabId
  return unifiedTabId ? { unifiedTabId, groupId } : null
}

/**
 * Move the active tab of the active group into a new pane column.
 *
 * @param direction Which side of the current pane the new column goes on.
 * @param worktreeId The worktree whose active tab should move.
 * @returns Whether a tab actually moved.
 */
export function moveActiveTabToNewPaneColumn(
  direction: TabSplitDirection,
  worktreeId: string | null | undefined
): boolean {
  const state = useAppStore.getState()
  const target = getActiveTabForPaneColumnMove(state, worktreeId)
  return target ? moveTabToNewPaneColumn({ ...target, direction }) : false
}
