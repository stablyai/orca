import { useCallback, useState } from 'react'
import type { DragEndEvent, DragMoveEvent, DragOverEvent } from '@dnd-kit/core'
import type { TabDragItemData } from './useTabDragSplit'

/** Outer fraction of a tab chip where drops reorder; the center opens a split. */
export const TAB_REORDER_EDGE_FRACTION = 0.3

export type TabPaneColumnSplitTarget = {
  groupId: string
  zone: 'left' | 'right'
}

// Why: when a tab is dragged over another tab's sortable rect, we compute
// which side of the hovered tab the drop will land on (before vs. after).
// Rendering a blue insertion bar at that edge makes the drop target feel
// VS Code-like even though dnd-kit's default sortable animation already
// slides tabs apart.
export type HoveredTabInsertion = {
  groupId: string
  visibleTabId: string
  side: 'left' | 'right'
}

export type TabIndicatorEdge = {
  visibleTabId: string
  side: 'left' | 'right'
}

export function resolveTabPaneColumnSplitOverTab(
  event: DragMoveEvent | DragOverEvent | DragEndEvent,
  isTabDragData: (value: unknown) => value is TabDragItemData,
  getDragCenter: (event: DragMoveEvent | DragOverEvent | DragEndEvent) => {
    x: number
    y: number
  } | null
): TabPaneColumnSplitTarget | null {
  const overData = event.over?.data.current
  const activeData = event.active.data.current
  if (!event.over || !isTabDragData(activeData) || !isTabDragData(overData)) {
    return null
  }
  if (activeData.unifiedTabId === overData.unifiedTabId) {
    return null
  }
  const center = getDragCenter(event)
  if (!center) {
    return null
  }
  const edge = event.over.rect.width * TAB_REORDER_EDGE_FRACTION
  const localX = center.x - event.over.rect.left
  if (localX > edge && localX < event.over.rect.width - edge) {
    // Why: tab-on-tab pane splits only apply within one split pane. Dragging
    // across existing split panes should insert at a tab slot instead.
    if (activeData.groupId !== overData.groupId) {
      return null
    }
    const midpoint = event.over.rect.left + event.over.rect.width / 2
    return {
      groupId: overData.groupId,
      zone: center.x < midpoint ? 'left' : 'right'
    }
  }
  return null
}

export function resolveTabInsertion(
  event: DragMoveEvent | DragOverEvent | DragEndEvent,
  isTabDragData: (value: unknown) => value is TabDragItemData,
  getDragCenter: (event: DragMoveEvent | DragOverEvent | DragEndEvent) => {
    x: number
    y: number
  } | null
): HoveredTabInsertion | null {
  const overData = event.over?.data.current
  const activeData = event.active.data.current
  if (!event.over || !isTabDragData(activeData) || !isTabDragData(overData)) {
    return null
  }
  // Why: dropping a tab onto itself is a no-op — suppress the indicator there
  // so users don't see a false positive target.
  if (activeData.unifiedTabId === overData.unifiedTabId) {
    return null
  }
  const center = getDragCenter(event)
  if (!center) {
    return null
  }
  const edge = event.over.rect.width * TAB_REORDER_EDGE_FRACTION
  const localX = center.x - event.over.rect.left
  const midpoint = event.over.rect.left + event.over.rect.width / 2

  // Why: moving tabs between split panes should always target a tab-strip slot.
  // Only same-pane drags reserve the tab center for opening a new split pane.
  if (activeData.groupId !== overData.groupId) {
    return {
      groupId: overData.groupId,
      visibleTabId: overData.visibleTabId,
      side: center.x < midpoint ? 'left' : 'right'
    }
  }

  if (localX <= edge) {
    return {
      groupId: overData.groupId,
      visibleTabId: overData.visibleTabId,
      side: 'left'
    }
  }
  if (localX >= event.over.rect.width - edge) {
    return {
      groupId: overData.groupId,
      visibleTabId: overData.visibleTabId,
      side: 'right'
    }
  }
  return null
}

export function resolveTabIndicatorEdges(
  orderedVisibleTabIds: string[],
  hoveredTabInsertion: HoveredTabInsertion | null
): TabIndicatorEdge[] {
  if (!hoveredTabInsertion || orderedVisibleTabIds.length === 0) {
    return []
  }

  const hoveredIndex = orderedVisibleTabIds.indexOf(hoveredTabInsertion.visibleTabId)
  if (hoveredIndex === -1) {
    return []
  }

  const insertionIndex = hoveredIndex + (hoveredTabInsertion.side === 'right' ? 1 : 0)
  const edges: TabIndicatorEdge[] = []

  // Why: VS Code draws the insertion cue by marking both tabs adjacent to the
  // slot so the two 1px edges read as one continuous bar between them.
  if (insertionIndex > 0) {
    edges.push({ visibleTabId: orderedVisibleTabIds[insertionIndex - 1]!, side: 'right' })
  }
  if (insertionIndex < orderedVisibleTabIds.length) {
    edges.push({ visibleTabId: orderedVisibleTabIds[insertionIndex]!, side: 'left' })
  }

  return edges
}

function equal(a: HoveredTabInsertion | null, b: HoveredTabInsertion | null): boolean {
  if (a === b) {
    return true
  }
  return (
    a !== null &&
    b !== null &&
    a.groupId === b.groupId &&
    a.visibleTabId === b.visibleTabId &&
    a.side === b.side
  )
}

export function useHoveredTabInsertion(
  isTabDragData: (value: unknown) => value is TabDragItemData,
  getDragCenter: (event: DragMoveEvent | DragOverEvent) => { x: number; y: number } | null
): {
  hoveredTabInsertion: HoveredTabInsertion | null
  update: (event: DragMoveEvent | DragOverEvent) => void
  clear: () => void
} {
  const [hoveredTabInsertion, setHoveredTabInsertion] = useState<HoveredTabInsertion | null>(null)
  const update = useCallback(
    (event: DragMoveEvent | DragOverEvent) => {
      const next = resolveTabInsertion(event, isTabDragData, getDragCenter)
      setHoveredTabInsertion((prev) => (equal(prev, next) ? prev : next))
    },
    [isTabDragData, getDragCenter]
  )
  const clear = useCallback(() => setHoveredTabInsertion(null), [])
  return { hoveredTabInsertion, update, clear }
}
