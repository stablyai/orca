import type { DragEndEvent, DragMoveEvent, DragOverEvent } from '@dnd-kit/core'

type DragPointerEvent = Pick<
  DragMoveEvent | DragOverEvent | DragEndEvent,
  'activatorEvent' | 'delta' | 'active'
>

/** Pointer position during a tab drag. Why: sortable tabs stay visually anchored
 *  (no transform) while DragOverlay follows the cursor, so active.rect.translated
 *  never tracks the pointer and panel-edge split targets would stay wrong. */
export function getDragPointer(event: DragPointerEvent): { x: number; y: number } | null {
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
