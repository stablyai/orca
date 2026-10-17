import type { DragEndEvent } from '@dnd-kit/core'

type Point = { x: number; y: number }

/** Stands in for the pointerdown dnd-kit keeps as `activatorEvent`. */
class PointerDownFixture extends Event {
  /** A pointerdown at (`clientX`, `clientY`). */
  constructor(
    readonly clientX: number,
    readonly clientY: number
  ) {
    super('pointerdown')
  }
}

/** A dnd-kit drag event whose `delta` derives `derivedPointer` from the pointerdown position. */
export function makeTabDragEvent({
  activeData,
  overData,
  overRect = { left: 0, width: 100 },
  pointerDown = { x: 0, y: 0 },
  derivedPointer = pointerDown
}: {
  activeData: Record<string, unknown>
  overData: Record<string, unknown> | null
  overRect?: { left: number; width: number }
  pointerDown?: Point
  derivedPointer?: Point
}): DragEndEvent {
  return {
    activatorEvent: new PointerDownFixture(pointerDown.x, pointerDown.y),
    active: {
      id: 'active',
      data: { current: activeData },
      rect: { current: { initial: null, translated: null } }
    },
    collisions: null,
    delta: { x: derivedPointer.x - pointerDown.x, y: derivedPointer.y - pointerDown.y },
    over: overData
      ? {
          id: 'over',
          disabled: false,
          data: { current: overData },
          rect: {
            left: overRect.left,
            width: overRect.width,
            right: overRect.left + overRect.width,
            top: 4,
            height: 31,
            bottom: 35
          }
        }
      : null
  }
}
