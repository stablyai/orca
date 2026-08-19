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

type ActiveTabPaneColumnState = Pick<
  ReturnType<typeof useAppStore.getState>,
  'activeTabId' | 'activeWorktreeId' | 'unifiedTabsByWorktree'
>

// Why: the context menu carries the clicked tab, but a command only knows the active one.
export function findActiveTabForPaneColumnMove(
  state: ActiveTabPaneColumnState
): { unifiedTabId: string; groupId: string } | null {
  const { activeTabId, activeWorktreeId } = state
  if (!activeTabId || !activeWorktreeId) {
    return null
  }
  const tab = (state.unifiedTabsByWorktree[activeWorktreeId] ?? []).find(
    (candidate) => candidate.id === activeTabId
  )
  return tab ? { unifiedTabId: tab.id, groupId: tab.groupId } : null
}

export function canMoveActiveTabToNewPaneColumn(): boolean {
  const state = useAppStore.getState()
  const target = findActiveTabForPaneColumnMove(state)
  return (
    target !== null &&
    canMoveTabToNewPaneColumnFromState(state, target.unifiedTabId, target.groupId)
  )
}

export function moveActiveTabToNewPaneColumn(direction: TabSplitDirection): boolean {
  const target = findActiveTabForPaneColumnMove(useAppStore.getState())
  return target === null ? false : moveTabToNewPaneColumn({ ...target, direction })
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
