export const IMAGE_VIEWER_PAN_DRAG_THRESHOLD = 4

export type ImageViewerPanTrigger = 'middle' | 'space-left'

export type ImageViewerPanPoint = {
  x: number
  y: number
}

export function getImageViewerPanTrigger(
  button: number,
  isSpacePressed: boolean
): ImageViewerPanTrigger | null {
  if (button === 1) {
    return 'middle'
  }
  if (button === 0 && isSpacePressed) {
    return 'space-left'
  }
  return null
}

export function hasImageViewerPanCrossedThreshold(
  start: ImageViewerPanPoint,
  current: ImageViewerPanPoint
): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= IMAGE_VIEWER_PAN_DRAG_THRESHOLD
}

export function getImageViewerPanScrollPosition({
  startScroll,
  startPointer,
  currentPointer
}: {
  startScroll: ImageViewerPanPoint
  startPointer: ImageViewerPanPoint
  currentPointer: ImageViewerPanPoint
}): ImageViewerPanPoint {
  return {
    x: startScroll.x - (currentPointer.x - startPointer.x),
    y: startScroll.y - (currentPointer.y - startPointer.y)
  }
}
