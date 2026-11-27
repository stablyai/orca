// Overlays drawn above the transcript sit outside its scroller, so a wheel gesture over one never
// reaches the transcript's own handler. They forward it here instead.

const WHEEL_DELTA_LINE = 1
const WHEEL_DELTA_PAGE = 2
/** Nominal line height for line-mode wheel deltas, which arrive as ~3 per notch. */
const WHEEL_LINE_PX = 16

/**
 * Scrolls `element` by a wheel gesture and returns the pixel delta it moved, or null for a
 * pinch-zoom (`ctrlKey`), which the caller must leave alone.
 */
export function forwardWheelToScroller(
  element: HTMLElement,
  event: Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'ctrlKey'>
): number | null {
  if (event.ctrlKey) {
    return null
  }
  const scale =
    event.deltaMode === WHEEL_DELTA_LINE
      ? WHEEL_LINE_PX
      : event.deltaMode === WHEEL_DELTA_PAGE
        ? element.clientHeight
        : 1
  const deltaPx = event.deltaY * scale
  element.scrollTop += deltaPx
  return deltaPx
}
