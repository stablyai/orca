export const ROOM_IMAGE_ZOOM_PRESETS = [25, 50, 100, 150, 200]
export const MAX_ROOM_IMAGE_ZOOM_PERCENT = 500

export type RoomImagePoint = { clientX: number; clientY: number }
export type RoomImageTouchGesture = RoomImagePoint & { distance: number }

export function readRoomImageTouchGesture(
  points: Map<number, RoomImagePoint>
): RoomImageTouchGesture | null {
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

export function clampRoomImageAnchor(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5
}

export function roomImagePointInside(point: RoomImagePoint, rect: DOMRect): boolean {
  return (
    point.clientX >= rect.left &&
    point.clientX <= rect.right &&
    point.clientY >= rect.top &&
    point.clientY <= rect.bottom
  )
}

export function getRoomImageWheelZoomFactor(deltaY: number, deltaMode: number): number {
  const normalizedDelta = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 800 : deltaY
  return Math.exp(-normalizedDelta / 200)
}
