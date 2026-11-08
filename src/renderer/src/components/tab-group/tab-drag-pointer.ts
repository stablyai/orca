import type { DragEndEvent, DragMoveEvent, DragOverEvent } from '@dnd-kit/core'

type DragPointerEvent = Pick<
  DragMoveEvent | DragOverEvent | DragEndEvent,
  'activatorEvent' | 'delta' | 'active'
>

type DragPointer = { x: number; y: number }

let recordedPointer: DragPointer | null = null

/** Why: dnd-kit's `delta` is scroll-adjusted, so a pointer derived from it drifts by a scrolled source strip's offset. */
export function recordTabDragPointer(point: DragPointer | null): void {
  recordedPointer = point
}

/** Read the pointer directly: anchored sortable rects do not follow the overlay and cannot locate pane-edge split targets. */
export function getDragPointer(event: DragPointerEvent): DragPointer | null {
  if (recordedPointer) {
    return recordedPointer
  }

  const activator = event.activatorEvent
  if (
    activator &&
    typeof activator === 'object' &&
    'clientX' in activator &&
    'clientY' in activator &&
    typeof activator.clientX === 'number' &&
    typeof activator.clientY === 'number'
  ) {
    return {
      x: activator.clientX + event.delta.x,
      y: activator.clientY + event.delta.y
    }
  }

  const initial = event.active.rect.current.initial
  if (!initial) {
    return null
  }

  return {
    x: initial.left + initial.width / 2 + event.delta.x,
    y: initial.top + initial.height / 2 + event.delta.y
  }
}
