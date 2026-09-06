export const IMAGE_ZOOM_LEVELS = [
  25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500
]
export const MAX_IMAGE_ZOOM_PERCENT = 500

export type ImagePoint = { clientX: number; clientY: number }
export type ImageTouchGesture = ImagePoint & { distance: number }

export function readImageTouchGesture(points: Map<number, ImagePoint>): ImageTouchGesture | null {
  const iterator = points.values()
  const first = iterator.next().value
  const second = iterator.next().value
  if (!first || !second) {
    return null
  }
  const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)
  return distance > 0
    ? {
        clientX: (first.clientX + second.clientX) / 2,
        clientY: (first.clientY + second.clientY) / 2,
        distance
      }
    : null
}

export function clampImageAnchor(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5
}

export function imagePointInside(point: ImagePoint, rect: DOMRect): boolean {
  return (
    point.clientX >= rect.left &&
    point.clientX <= rect.right &&
    point.clientY >= rect.top &&
    point.clientY <= rect.bottom
  )
}

export function getImageWheelZoomFactor(deltaY: number, deltaMode: number): number {
  const normalizedDelta = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 800 : deltaY
  return Math.exp(-normalizedDelta / 200)
}
