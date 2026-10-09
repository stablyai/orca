import type { TabCluster, TabGroup } from '../../../../shared/tab-types'
import { getTabClusterForTab } from '../../store/slices/tabs/tab-cluster-model'
import { isTabClusterDragData, type TabStripDragItemData } from './tab-drag-data'

export type TabClusterDropTarget = {
  /** Insertion slot after removing the dragged members from the target pane. */
  index: number
  clusterId: string | null
}

export function resolveTabClusterDropTarget({
  activeDrag,
  overData,
  targetGroup,
  side
}: {
  activeDrag: TabStripDragItemData
  overData: TabStripDragItemData
  targetGroup: TabGroup
  side: 'left' | 'right'
}): TabClusterDropTarget | null {
  if (
    activeDrag.worktreeId !== targetGroup.worktreeId ||
    overData.worktreeId !== targetGroup.worktreeId ||
    overData.groupId !== targetGroup.id
  ) {
    return null
  }

  const samePane = activeDrag.groupId === targetGroup.id
  const activeCluster =
    samePane && isTabClusterDragData(activeDrag)
      ? targetGroup.tabClusters?.find((cluster) => cluster.id === activeDrag.clusterId)
      : null
  const movedTabIds = new Set(
    samePane
      ? isTabClusterDragData(activeDrag)
        ? (activeCluster?.tabIds ?? [])
        : [activeDrag.unifiedTabId]
      : []
  )
  const hoveredCluster = isTabClusterDragData(overData)
    ? targetGroup.tabClusters?.find((cluster) => cluster.id === overData.clusterId)
    : getTabClusterForTab(targetGroup.tabClusters, overData.unifiedTabId)
  let rawIndex: number
  let clusterId: string | null = null

  if (isTabClusterDragData(activeDrag)) {
    if (samePane && !activeCluster) {
      return null
    }
    if (samePane && hoveredCluster?.id === activeDrag.clusterId) {
      return null
    }
    if (hoveredCluster) {
      const span = getTabClusterSpan(targetGroup, hoveredCluster)
      if (!span) {
        return null
      }
      rawIndex = side === 'left' ? span.start : span.end
    } else if (!isTabClusterDragData(overData)) {
      const hoveredIndex = targetGroup.tabOrder.indexOf(overData.unifiedTabId)
      if (hoveredIndex === -1) {
        return null
      }
      rawIndex = hoveredIndex + (side === 'right' ? 1 : 0)
    } else {
      return null
    }
    clusterId = activeDrag.clusterId
  } else if (isTabClusterDragData(overData)) {
    if (!hoveredCluster) {
      return null
    }
    const span = getTabClusterSpan(targetGroup, hoveredCluster)
    if (!span) {
      return null
    }
    rawIndex = span.end
    clusterId = hoveredCluster.id
  } else {
    if (samePane && activeDrag.unifiedTabId === overData.unifiedTabId) {
      return null
    }
    const hoveredIndex = targetGroup.tabOrder.indexOf(overData.unifiedTabId)
    if (hoveredIndex === -1) {
      return null
    }
    rawIndex = hoveredIndex + (side === 'right' ? 1 : 0)
    for (const cluster of targetGroup.tabClusters ?? []) {
      const span = getTabClusterSpan(targetGroup, cluster)
      if (!span) {
        continue
      }
      const inside = rawIndex > span.start && rawIndex < span.end
      const memberBoundary =
        samePane &&
        (rawIndex === span.start || rawIndex === span.end) &&
        cluster.tabIds.includes(activeDrag.unifiedTabId)
      if (inside || memberBoundary) {
        clusterId = cluster.id
        break
      }
    }
  }

  let removedBeforeSlot = 0
  for (let index = 0; index < rawIndex; index++) {
    if (movedTabIds.has(targetGroup.tabOrder[index])) {
      removedBeforeSlot++
    }
  }
  return { index: rawIndex - removedBeforeSlot, clusterId }
}

function getTabClusterSpan(
  group: TabGroup,
  cluster: TabCluster
): { start: number; end: number } | null {
  const first = cluster.tabIds[0]
  const last = cluster.tabIds.at(-1)
  if (!first || !last) {
    return null
  }
  const start = group.tabOrder.indexOf(first)
  const lastIndex = group.tabOrder.indexOf(last)
  return start === -1 || lastIndex < start ? null : { start, end: lastIndex + 1 }
}
