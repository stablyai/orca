export const MIN_SURFACE_ZOOM = 0.25
export const MAX_SURFACE_ZOOM = 8
export const SURFACE_ZOOM_STEP = 1.25
export const SURFACE_ZOOM_PADDING = 16

const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2
const PIXELS_PER_LINE = 16
const PIXELS_PER_PAGE = 800
const MAX_NORMALIZED_WHEEL_DELTA = 200
const WHEEL_ZOOM_SENSITIVITY = 300

type SurfaceZoomWheelEventLike = {
  ctrlKey: boolean
}

export type SurfaceContentDimensions = {
  width: number
  height: number
}

export type SurfaceSize = {
  width: number
  height: number
}

export type SurfaceZoomAnchor = {
  x: number
  y: number
}

export function clampSurfaceZoom(next: number): number {
  return Math.min(MAX_SURFACE_ZOOM, Math.max(MIN_SURFACE_ZOOM, next))
}

export function shouldHandleSurfaceZoomWheel(event: SurfaceZoomWheelEventLike): boolean {
  return event.ctrlKey
}

export function getPinchZoomFactor(deltaY: number, deltaMode: number): number {
  if (deltaY === 0) {
    return 1
  }

  const normalizedDeltaY =
    deltaMode === DOM_DELTA_LINE
      ? deltaY * PIXELS_PER_LINE
      : deltaMode === DOM_DELTA_PAGE
        ? deltaY * PIXELS_PER_PAGE
        : deltaY
  const boundedDeltaY = Math.max(
    -MAX_NORMALIZED_WHEEL_DELTA,
    Math.min(MAX_NORMALIZED_WHEEL_DELTA, normalizedDeltaY)
  )

  return Math.exp(-boundedDeltaY / WHEEL_ZOOM_SENSITIVITY)
}

export function getNextWheelSurfaceZoom(
  currentZoom: number,
  deltaY: number,
  deltaMode: number
): number {
  return clampSurfaceZoom(currentZoom * getPinchZoomFactor(deltaY, deltaMode))
}

export function getZoomedSurfaceLayoutSize({
  contentDimensions,
  surfaceSize,
  zoom,
  padding = SURFACE_ZOOM_PADDING
}: {
  contentDimensions: SurfaceContentDimensions | null
  surfaceSize: SurfaceSize | null
  zoom: number
  padding?: number
}): SurfaceContentDimensions | null {
  if (
    !contentDimensions ||
    !surfaceSize ||
    contentDimensions.width <= 0 ||
    contentDimensions.height <= 0 ||
    surfaceSize.width <= 0 ||
    surfaceSize.height <= 0
  ) {
    return null
  }

  const availableWidth = Math.max(0, surfaceSize.width - padding * 2)
  const availableHeight = Math.max(0, surfaceSize.height - padding * 2)
  if (availableWidth <= 0 || availableHeight <= 0) {
    return null
  }

  const fitScale = Math.min(
    1,
    availableWidth / contentDimensions.width,
    availableHeight / contentDimensions.height
  )
  const boundedZoom = clampSurfaceZoom(zoom)

  // Why: transformed content does not change scroll extents, so zoom must resize
  // the layout box for panning to reach the full image or diagram.
  return {
    width: contentDimensions.width * fitScale * boundedZoom,
    height: contentDimensions.height * fitScale * boundedZoom
  }
}

export function getAnchoredSurfaceScrollOffset({
  scrollOffset,
  anchorOffset,
  currentZoom,
  nextZoom
}: {
  scrollOffset: number
  anchorOffset: number
  currentZoom: number
  nextZoom: number
}): number {
  if (currentZoom <= 0) {
    return scrollOffset
  }

  return (scrollOffset + anchorOffset) * (nextZoom / currentZoom) - anchorOffset
}
