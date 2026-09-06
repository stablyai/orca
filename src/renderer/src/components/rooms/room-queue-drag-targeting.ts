import { closestCenter, pointerWithin, type CollisionDetection } from '@dnd-kit/core'
import { getEventCoordinates } from '@dnd-kit/utilities'
import {
  parseCollapsedSquareId,
  parseSharedRowId,
  parseSquareId,
  SHARED_ZONE_ID,
  squareId
} from './room-queue-projection'

const LONG_PRESS_MS = 600

export type RoomQueuePointer = { x: number; y: number }
export type RoomQueueLongPressState = {
  targetId: string | null
  timer: ReturnType<typeof setTimeout> | null
}
export type RoomQueueOverlaySurface = {
  elementRef: { current: HTMLDivElement | null }
  targetId: string | null
  itemIds: ReadonlySet<string>
}

export function pointInRect(
  point: RoomQueuePointer,
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>
): boolean {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  )
}

export function roomQueueSquareAtPointer(
  point: RoomQueuePointer,
  squares: ReadonlyMap<string, HTMLElement>
): string | null {
  for (const [participantId, square] of squares) {
    if (pointInRect(point, square.getBoundingClientRect())) {
      return participantId
    }
  }
  return null
}

export function roomQueuePointInSquareBounds(
  point: RoomQueuePointer,
  squares: ReadonlyMap<string, HTMLElement>
): boolean {
  const rects = [...squares.values()].map((square) => square.getBoundingClientRect())
  if (rects.length === 0) {
    return false
  }
  return pointInRect(point, {
    left: Math.min(...rects.map((rect) => rect.left)),
    right: Math.max(...rects.map((rect) => rect.right)),
    top: Math.min(...rects.map((rect) => rect.top)),
    bottom: Math.max(...rects.map((rect) => rect.bottom))
  })
}

export function roomQueueLongPressTarget(input: {
  activatorEvent: Event
  point: RoomQueuePointer | null
  squares: ReadonlyMap<string, HTMLElement>
  overlay?: RoomQueueOverlaySurface
}): string | null {
  const point = roomQueuePointerForDrag(input, input.point)
  if (point && roomQueuePointInOverlay(point, input.overlay)) {
    return null
  }
  return point ? roomQueueSquareAtPointer(point, input.squares) : null
}

export function clearRoomQueueLongPress(state: RoomQueueLongPressState): void {
  if (state.timer !== null) {
    clearTimeout(state.timer)
  }
  state.targetId = null
  state.timer = null
}

export function updateRoomQueueLongPress(
  state: RoomQueueLongPressState,
  targetId: string | null,
  open: (participantId: string) => void
): void {
  if (state.targetId === targetId) {
    return
  }
  clearRoomQueueLongPress(state)
  if (targetId) {
    state.targetId = targetId
    state.timer = setTimeout(() => open(targetId), LONG_PRESS_MS)
  }
}

export function trackRoomQueuePointer(update: (point: RoomQueuePointer) => void): () => void {
  const capture = (event: PointerEvent): void => update({ x: event.clientX, y: event.clientY })
  window.addEventListener('pointermove', capture, true)
  window.addEventListener('pointerup', capture, true)
  return () => {
    window.removeEventListener('pointermove', capture, true)
    window.removeEventListener('pointerup', capture, true)
  }
}

export function roomQueuePointerForDrag(
  event: { activatorEvent: Event },
  point: RoomQueuePointer | null
): RoomQueuePointer | null {
  return getEventCoordinates(event.activatorEvent) ? point : null
}

export function roomQueueDropTarget(
  event: { activatorEvent: Event; over: { id: string | number } | null },
  lastPointer: RoomQueuePointer | null,
  squares: ReadonlyMap<string, HTMLElement>,
  overlay: RoomQueueOverlaySurface,
  sharedElement: HTMLDivElement | null
): string | null {
  const point = roomQueuePointerForDrag(event, lastPointer)
  const overId = event.over ? String(event.over.id) : null
  if (point && roomQueuePointInOverlay(point, overlay)) {
    return overId && (overId === overlay.targetId || overlay.itemIds.has(overId))
      ? overId
      : overlay.targetId
  }
  const collapsed = point && roomQueueSquareAtPointer(point, squares)
  if (collapsed) {
    return squareId(collapsed)
  }
  if (overId && overId !== SHARED_ZONE_ID && !parseSquareId(overId)) {
    return overId
  }
  if (point && sharedElement && pointInRect(point, sharedElement.getBoundingClientRect())) {
    return SHARED_ZONE_ID
  }
  return overId
}

export function roomQueueSquareDropDisabled(
  participantId: string,
  expandedId: string | null
): boolean {
  return expandedId === participantId
}

function roomQueuePointInOverlay(
  point: RoomQueuePointer,
  overlay: RoomQueueOverlaySurface | undefined
): boolean {
  const element = overlay?.elementRef.current
  return Boolean(element && pointInRect(point, element.getBoundingClientRect()))
}

export function roomQueueCollision(
  args: Parameters<CollisionDetection>[0],
  overlay?: RoomQueueOverlaySurface
): ReturnType<CollisionDetection> {
  const pointerInOverlay = Boolean(
    args.pointerCoordinates && roomQueuePointInOverlay(args.pointerCoordinates, overlay)
  )
  const keyboardInOverlay = Boolean(
    !args.pointerCoordinates && overlay?.itemIds.has(String(args.active.id))
  )
  if (overlay && (pointerInOverlay || keyboardInOverlay)) {
    const allowed = new Set(overlay.itemIds)
    if (overlay.targetId) {
      allowed.add(overlay.targetId)
    }
    args = {
      ...args,
      droppableContainers: args.droppableContainers.filter((container) =>
        allowed.has(String(container.id))
      )
    }
  }
  if (!args.pointerCoordinates) {
    return closestCenter(args)
  }
  const exact = pointerWithin(args)
  const exactSquares = exact.filter((collision) => parseCollapsedSquareId(String(collision.id)))
  if (exactSquares.length > 0) {
    return exactSquares
  }
  const exactRows = exact.filter((collision) => {
    const id = String(collision.id)
    return id !== SHARED_ZONE_ID && !parseSquareId(id)
  })
  if (exactRows.length > 0) {
    return exactRows
  }
  if (
    parseSharedRowId(String(args.active.id)) === null &&
    exact.some((collision) => String(collision.id) === SHARED_ZONE_ID)
  ) {
    const sharedRows = args.droppableContainers.filter((container) =>
      parseSharedRowId(String(container.id))
    )
    if (sharedRows.length > 0) {
      return closestCenter({ ...args, droppableContainers: sharedRows })
    }
  }
  return exact
}
