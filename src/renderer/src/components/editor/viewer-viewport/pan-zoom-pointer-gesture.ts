import type { PanZoomPoint } from '../../../../../shared/document-preview/pan-zoom-view'

/** Movement under this many pixels still counts as a click. */
const CLICK_SLOP = 4
export type PanZoomPointerGesture = {
  start: PanZoomPoint
  last: PanZoomPoint
  pan: boolean
  alt: boolean
}

export function panZoomPointerDelta(
  gesture: PanZoomPointerGesture,
  point: PanZoomPoint,
  dragToPan: boolean
): PanZoomPoint | null {
  if (!gesture.pan) {
    if (
      !dragToPan ||
      Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) < CLICK_SLOP
    ) {
      return null
    }
    gesture.pan = true
  }
  const delta = { x: point.x - gesture.last.x, y: point.y - gesture.last.y }
  gesture.last = point
  return delta
}

export function isPanZoomPointerClick(
  gesture: PanZoomPointerGesture,
  event: Pick<PointerEvent, 'clientX' | 'clientY' | 'pointerType'>,
  dragToPan: boolean
): boolean {
  return (
    !gesture.alt &&
    !(dragToPan && gesture.pan && event.pointerType === 'mouse') &&
    Math.hypot(event.clientX - gesture.start.x, event.clientY - gesture.start.y) < CLICK_SLOP
  )
}
