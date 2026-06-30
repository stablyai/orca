import type { TabDragItemData } from './useTabDragSplit'
import { isPaneDropData, isTabDragData } from './useTabDragSplit'

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
    // Why: tab-strip hovers target split drops or reorder slots. Previewing
    // the hovered tab's content reads like an in-tab split even though the drop
    // opens a new split.
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
  // Why: same-group splits keep the previewed active tab in the source pane via
  // dropUnifiedTab; restoring the pre-drag snapshot would undo that preview.
  if (restoreSnapshot || activeData.groupId === targetGroupId) {
    return undefined
  }
  return activeData
}
