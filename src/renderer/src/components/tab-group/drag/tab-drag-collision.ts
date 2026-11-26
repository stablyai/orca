import {
  closestCenter,
  pointerWithin,
  type ClientRect,
  type Collision,
  type CollisionDetection,
  type DroppableContainer,
  type UniqueIdentifier
} from '@dnd-kit/core'
import { isPaneDropData, isTabDragData } from './tab-drag-data'
import {
  findTabGroupPanelUnderPointer,
  type TabGroupPanelGeometrySnapshot
} from './tab-group-panel-split-target'

/** Marks a tab strip's horizontal scroller, whose box is the only part of the strip a user can see. */
export const TAB_STRIP_SCROLLER_ATTRIBUTE = 'data-tab-strip-scroller'

function intersectRects(a: ClientRect, b: ClientRect): ClientRect | null {
  const left = Math.max(a.left, b.left)
  const right = Math.min(a.right, b.right)
  const top = Math.max(a.top, b.top)
  const bottom = Math.min(a.bottom, b.bottom)
  if (right <= left || bottom <= top) {
    return null
  }
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

function visibleTabRect(
  node: HTMLElement | null,
  measured: ClientRect,
  scrollerRects: Map<Element, ClientRect>
): ClientRect | null {
  const scroller = node?.closest(`[${TAB_STRIP_SCROLLER_ATTRIBUTE}]`)
  if (!scroller) {
    return measured
  }
  let scrollerRect = scrollerRects.get(scroller)
  if (!scrollerRect) {
    scrollerRect = scroller.getBoundingClientRect()
    scrollerRects.set(scroller, scrollerRect)
  }
  return intersectRects(measured, scrollerRect)
}

function distanceToRect(point: { x: number; y: number }, rect: ClientRect): number {
  const dx = Math.max(rect.left - point.x, 0, point.x - rect.right)
  const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom)
  return Math.hypot(dx, dy)
}

/**
 * Resolve drops against what the user sees: only the split under the pointer, only the visible part
 * of each tab (scrolled-off tabs keep unclipped rects over the neighbouring split), and in strip
 * gaps the tab nearest the pointer.
 */
export function resolveTabDragCollisions(
  args: Parameters<CollisionDetection>[0],
  worktreeId: string,
  geometry: TabGroupPanelGeometrySnapshot | null
): Collision[] {
  const pointer = args.pointerCoordinates
  const panel =
    pointer && geometry ? findTabGroupPanelUnderPointer(worktreeId, pointer, { geometry }) : null
  const scrollerRects = new Map<Element, ClientRect>()
  const droppableContainers: DroppableContainer[] = []
  const droppableRects = new Map<UniqueIdentifier, ClientRect>()
  const tabs: { droppable: DroppableContainer; rect: ClientRect }[] = []
  for (const droppable of args.droppableContainers) {
    const data = droppable.data.current
    const isTab = isTabDragData(data)
    if (panel && (isTab || isPaneDropData(data)) && data.groupId !== panel.groupId) {
      continue
    }
    const measured = args.droppableRects.get(droppable.id)
    const rect =
      measured && isTab ? visibleTabRect(droppable.node.current, measured, scrollerRects) : measured
    if (!rect) {
      continue
    }
    droppableContainers.push(droppable)
    droppableRects.set(droppable.id, rect)
    if (isTab) {
      tabs.push({ droppable, rect })
    }
  }
  const scoped = { ...args, droppableContainers, droppableRects }
  const hits = pointerWithin(scoped)
  if (hits.length > 0) {
    return hits
  }
  if (!pointer || tabs.length === 0) {
    return closestCenter(scoped)
  }
  return tabs
    .map(({ droppable, rect }): Collision => ({
      id: droppable.id,
      data: { droppableContainer: droppable, value: distanceToRect(pointer, rect) }
    }))
    .sort((a, b) => a.data!.value - b.data!.value)
}
