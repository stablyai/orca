export function getWheelScrollDeltaY(
  event: Pick<WheelEvent, 'deltaMode' | 'deltaY'>,
  pageHeight: number
): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * 16
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * pageHeight
  }
  return event.deltaY
}
