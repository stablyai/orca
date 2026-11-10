import { useCallback, useState } from 'react'
import type { DragEndEvent, DragMoveEvent, DragOverEvent } from '@dnd-kit/core'
import type { TabDragItemData } from './tab-drag-data'

// Keep tabs anchored and draw the insertion bar on the hovered tab’s before/after edge.
export type HoveredTabInsertion = {
  groupId: string
  visibleTabId: string
  side: 'left' | 'right'
}

export type TabIndicatorEdge = {
  visibleTabId: string
  side: 'left' | 'right'
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
  if (activeData.unifiedTabId === overData.unifiedTabId) {
    return null
  }
  const center = getDragCenter(event)
  if (!center) {
    return null
  }
  const midpoint = event.over.rect.left + event.over.rect.width / 2
  return {
    groupId: overData.groupId,
    visibleTabId: overData.visibleTabId,
    side: center.x < midpoint ? 'left' : 'right'
  }
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
  if (insertionIndex < orderedVisibleTabIds.length) {
    return [{ visibleTabId: orderedVisibleTabIds[insertionIndex]!, side: 'left' }]
  }
  return [{ visibleTabId: orderedVisibleTabIds[insertionIndex - 1]!, side: 'right' }]
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
