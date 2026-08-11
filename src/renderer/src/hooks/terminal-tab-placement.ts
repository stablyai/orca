import type { AppState } from '../store/types'

type TerminalTabPlacementState = Pick<
  AppState,
  'unifiedTabsByWorktree' | 'groupsByWorktree' | 'moveUnifiedTabToGroup' | 'reorderUnifiedTabs'
>

type TerminalTabPlacement = {
  targetGroupId?: string
  afterTabId?: string
}

function findUnifiedTab(state: TerminalTabPlacementState, worktreeId: string, tabId: string) {
  return state.unifiedTabsByWorktree?.[worktreeId]?.find(
    (tab) => tab.id === tabId || tab.entityId === tabId
  )
}

export function resolveTerminalTabPlacementGroupId(
  state: TerminalTabPlacementState,
  worktreeId: string,
  placement: TerminalTabPlacement
): string | undefined {
  const groups = state.groupsByWorktree?.[worktreeId] ?? []
  if (placement.targetGroupId) {
    return placement.targetGroupId
  }
  if (!placement.afterTabId) {
    return undefined
  }
  const anchor = findUnifiedTab(state, worktreeId, placement.afterTabId)
  return anchor && groups.some((group) => group.id === anchor.groupId) ? anchor.groupId : undefined
}

export function applyTerminalTabPlacement(
  state: TerminalTabPlacementState,
  worktreeId: string,
  createdTabId: string,
  placement: TerminalTabPlacement
): void {
  const targetGroupId = resolveTerminalTabPlacementGroupId(state, worktreeId, placement)
  const created = findUnifiedTab(state, worktreeId, createdTabId)
  if (!targetGroupId || !created || created.id === placement.afterTabId) {
    return
  }
  const targetGroup = state.groupsByWorktree?.[worktreeId]?.find(
    (group) => group.id === targetGroupId
  )
  if (!targetGroup) {
    return
  }
  const anchor = placement.afterTabId
    ? findUnifiedTab(state, worktreeId, placement.afterTabId)
    : undefined
  const order = targetGroup.tabOrder.filter((tabId) => tabId !== created.id)
  const anchorIndex = anchor?.groupId === targetGroupId ? order.indexOf(anchor.id) : -1
  const index = anchorIndex === -1 ? order.length : anchorIndex + 1
  if (created.groupId !== targetGroupId) {
    state.moveUnifiedTabToGroup(created.id, targetGroupId, {
      index,
      activate: false,
      recordInteraction: false
    })
    return
  }
  order.splice(index, 0, created.id)
  if (
    order.length === targetGroup.tabOrder.length &&
    order.every((tabId, orderIndex) => targetGroup.tabOrder[orderIndex] === tabId)
  ) {
    return
  }
  state.reorderUnifiedTabs(targetGroupId, order, { recordInteraction: false })
}
