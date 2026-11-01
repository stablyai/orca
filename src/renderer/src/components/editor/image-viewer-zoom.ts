export const IMAGE_VIEWER_ZOOM_STEP = 1.25

const DOM_DELTA_LINE = 1
const DOM_DELTA_PAGE = 2
const PIXELS_PER_LINE = 16
const PIXELS_PER_PAGE = 800
const MAX_NORMALIZED_WHEEL_DELTA = 100
const WHEEL_ZOOM_SENSITIVITY = 150

export function shouldHandleImageZoomWheel(event: { ctrlKey: boolean }): boolean {
  return event.ctrlKey
}

export function getWheelDeltaPixels(delta: number, deltaMode: number): number {
  return deltaMode === DOM_DELTA_LINE
    ? delta * PIXELS_PER_LINE
    : deltaMode === DOM_DELTA_PAGE
      ? delta * PIXELS_PER_PAGE
      : delta
}

export function getPinchZoomFactor(deltaY: number, deltaMode: number): number {
  if (deltaY === 0) {
    return 1
  }

  const normalizedDeltaY = getWheelDeltaPixels(deltaY, deltaMode)
  const boundedDeltaY = Math.max(
    -MAX_NORMALIZED_WHEEL_DELTA,
    Math.min(MAX_NORMALIZED_WHEEL_DELTA, normalizedDeltaY)
  )

  return Math.exp(-boundedDeltaY / WHEEL_ZOOM_SENSITIVITY)
}
