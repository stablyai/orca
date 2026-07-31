import type { AppState } from '../types'
import type { TabGroup, TabGroupLayoutNode } from '../../../../shared/types'

export type TerminalTabProjectionState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
  | 'activeGroupIdByWorktree'
  | 'layoutByWorktree'
  | 'activeTabIdByWorktree'
>

function collectLayoutGroupIds(node: TabGroupLayoutNode | undefined, ids: string[]): void {
  if (!node) {
    return
  }
  if (node.type === 'leaf') {
    ids.push(node.groupId)
    return
  }
  collectLayoutGroupIds(node.first, ids)
  collectLayoutGroupIds(node.second, ids)
}

export function layoutExactlyCoversGroups(
  layout: TabGroupLayoutNode | undefined,
  groups: readonly TabGroup[]
): boolean {
  if (!layout) {
    return false
  }
  const layoutGroupIds: string[] = []
  collectLayoutGroupIds(layout, layoutGroupIds)
  const groupIds = new Set(groups.map((group) => group.id))
  return (
    layoutGroupIds.length === groups.length &&
    new Set(layoutGroupIds).size === layoutGroupIds.length &&
    layoutGroupIds.every((groupId) => groupIds.has(groupId))
  )
}

export function hasTerminalTabProjectionInvariant(
  state: TerminalTabProjectionState,
  worktreeId: string,
  tabId: string
): boolean {
  const backingTabs = (state.tabsByWorktree[worktreeId] ?? []).filter((tab) => tab.id === tabId)
  if (backingTabs.length !== 1) {
    return false
  }
  const projections = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
    (tab) => tab.contentType === 'terminal' && tab.entityId === tabId
  )
  if (projections.length !== 1) {
    return false
  }
  const projection = projections[0]
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const owningGroup = groups.find((group) => group.id === projection.groupId)
  if (!owningGroup || !layoutExactlyCoversGroups(state.layoutByWorktree[worktreeId], groups)) {
    return false
  }
  let orderOccurrences = 0
  for (const group of groups) {
    orderOccurrences += group.tabOrder.filter((id) => id === projection.id).length
  }
  return orderOccurrences === 1 && owningGroup.tabOrder.includes(projection.id)
}
