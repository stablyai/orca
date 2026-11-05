import { isPaneDropData, isTabDragData, type TabDragItemData } from './tab-drag-data'

export type DragPreviewTabTarget = {
  groupId: string
  tabId: string | null
}

export function resolveDragPreviewTabId({
  activeDrag,
  overData,
  preDragActiveTabIdByGroup,
  lastHoveredTabPreview = null
}: {
  activeDrag: TabDragItemData
  overData: unknown
  preDragActiveTabIdByGroup: Record<string, string | null>
  lastHoveredTabPreview?: DragPreviewTabTarget | null
}): DragPreviewTabTarget {
  const sourceGroupId = activeDrag.groupId
  const sourcePreDragTabId = preDragActiveTabIdByGroup[sourceGroupId] ?? null

  if (isTabDragData(overData) && overData.unifiedTabId !== activeDrag.unifiedTabId) {
    // Keep source content over strip targets; previewing the hovered tab would imply an in-tab split.
    return { groupId: sourceGroupId, tabId: sourcePreDragTabId }
  }

  if (isPaneDropData(overData)) {
    if (lastHoveredTabPreview?.groupId === overData.groupId && lastHoveredTabPreview.tabId) {
      return lastHoveredTabPreview
    }
    if (overData.groupId === sourceGroupId) {
      return { groupId: sourceGroupId, tabId: sourcePreDragTabId }
    }
    return {
      groupId: overData.groupId,
      tabId: preDragActiveTabIdByGroup[overData.groupId] ?? null
    }
  }

  return { groupId: sourceGroupId, tabId: sourcePreDragTabId }
}

export function resolveSourceGroupRestoreOnDrop(
  activeData: TabDragItemData,
  targetGroupId: string,
  restoreSnapshot: boolean
): TabDragItemData | undefined {
  // Same-group splits retain the previewed active tab; restoring the old snapshot would undo that preview.
  if (restoreSnapshot || activeData.groupId === targetGroupId) {
    return undefined
  }
  return activeData
}
