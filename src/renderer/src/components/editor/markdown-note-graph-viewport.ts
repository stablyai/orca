export type ViewBox = { x: number; y: number; width: number; height: number }
export type ViewPoint = { x: number; y: number }

const ZOOM_STEP = 1.15
const MAX_ZOOM_IN = 20
const MAX_ZOOM_OUT = 5

/** Zooms around `anchor` (in graph units), clamped relative to the fitted view so it can always return. */
export function zoomViewBox(
  box: ViewBox,
  fitted: ViewBox,
  deltaY: number,
  anchor: ViewPoint
): ViewBox {
  if (deltaY === 0) {
    return box
  }
  const requested = deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP
  const width = Math.min(
    Math.max(box.width * requested, fitted.width / MAX_ZOOM_IN),
    fitted.width * MAX_ZOOM_OUT
  )
  const factor = width / box.width
  return {
    x: anchor.x - (anchor.x - box.x) * factor,
    y: anchor.y - (anchor.y - box.y) * factor,
    width,
    height: box.height * factor
  }
}

/** Graph units per screen pixel for an SVG drawn with the default `xMidYMid meet`. */
export function viewBoxUnitsPerPixel(
  box: ViewBox,
  clientWidth: number,
  clientHeight: number
): number {
  return Math.max(box.width / Math.max(1, clientWidth), box.height / Math.max(1, clientHeight))
}

/** The graph point under a client position, for the same `meet` scaling. */
export function clientToViewPoint(
  box: ViewBox,
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number
): ViewPoint {
  const scale = viewBoxUnitsPerPixel(box, rect.width, rect.height)
  const offsetX = (rect.width * scale - box.width) / 2
  const offsetY = (rect.height * scale - box.height) / 2
  return {
    x: box.x - offsetX + (clientX - rect.left) * scale,
    y: box.y - offsetY + (clientY - rect.top) * scale
  }
}
