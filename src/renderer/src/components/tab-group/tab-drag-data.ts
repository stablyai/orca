import type { TabClusterColor, TabGroup } from '../../../../shared/tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { TabSplitDirection } from '../../store/slices/tabs'

export type TabDropZone = 'center' | TabSplitDirection

export type TabDragItemData = {
  kind: 'tab'
  worktreeId: string
  groupId: string
  unifiedTabId: string
  visibleTabId: string
  tabType: 'terminal' | 'editor' | 'agent-session' | 'browser' | 'simulator'
  label: string
  iconPath?: string
  color?: string | null
  agent?: TuiAgent | null
}

export type TabPaneDropData = {
  kind: 'pane-body'
  worktreeId: string
  groupId: string
}

/** Sortable data of a tab-cluster chip; dragging it moves every member. */
export type TabClusterDragItemData = {
  kind: 'tab-cluster'
  worktreeId: string
  groupId: string
  clusterId: string
  name: string
  color: TabClusterColor
  collapsed: boolean
}

export type TabStripDragItemData = TabDragItemData | TabClusterDragItemData

export function getTabClusterSortableId(groupId: string, clusterId: string): string {
  return `tab-cluster:${groupId}:${clusterId}`
}

export function isTabClusterDragData(value: unknown): value is TabClusterDragItemData {
  return (
    value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'tab-cluster'
  )
}

export function isTabStripDragData(value: unknown): value is TabStripDragItemData {
  return isTabDragData(value) || isTabClusterDragData(value)
}

export function canDropTabIntoPaneBody({
  activeDrag,
  groupsByWorktree,
  overGroupId,
  worktreeId
}: {
  activeDrag: TabStripDragItemData | null
  groupsByWorktree: Record<string, TabGroup[]>
  overGroupId: string
  worktreeId: string
}): boolean {
  if (!activeDrag || activeDrag.worktreeId !== worktreeId) {
    return false
  }

  const overGroup = (groupsByWorktree[worktreeId] ?? []).find((group) => group.id === overGroupId)
  if (!overGroup) {
    return false
  }

  if (isTabClusterDragData(activeDrag)) {
    const sourceGroup = (groupsByWorktree[worktreeId] ?? []).find(
      (group) => group.id === activeDrag.groupId
    )
    const cluster = sourceGroup?.tabClusters?.find((item) => item.id === activeDrag.clusterId)
    return Boolean(
      cluster?.tabIds.length &&
      (activeDrag.groupId !== overGroupId ||
        overGroup.tabOrder.some((id) => !cluster.tabIds.includes(id)))
    )
  }
  return activeDrag.groupId !== overGroupId || overGroup.tabOrder.length > 1
}

export function isTabDragData(value: unknown): value is TabDragItemData {
  return value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'tab'
}

export function isPaneDropData(value: unknown): value is TabPaneDropData {
  return (
    value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'pane-body'
  )
}
