import {
  type SurfaceContentDimensions,
  type SurfaceSize,
  type SurfaceZoomAnchor,
  clampSurfaceZoom,
  getAnchoredSurfaceScrollOffset,
  getNextWheelSurfaceZoom,
  getSurfacePinchZoomFactor,
  getZoomedSurfaceLayoutSize,
  shouldHandleSurfaceZoomWheel
} from './anchored-surface-zoom'

export const MIN_IMAGE_VIEWER_ZOOM = 0.25
export const MAX_IMAGE_VIEWER_ZOOM = 8
export const IMAGE_VIEWER_ZOOM_STEP = 1.25
export const IMAGE_VIEWER_SURFACE_PADDING = 16
export const IMAGE_VIEWER_ZOOM_BOUNDS = {
  min: MIN_IMAGE_VIEWER_ZOOM,
  max: MAX_IMAGE_VIEWER_ZOOM
}

type ImageZoomWheelEventLike = {
  ctrlKey: boolean
  metaKey?: boolean
}

export type ImageViewerImageDimensions = SurfaceContentDimensions
export type ImageViewerSurfaceSize = SurfaceSize
export type ImageViewerZoomAnchor = SurfaceZoomAnchor

export function clampImageViewerZoom(next: number): number {
  return clampSurfaceZoom(next, IMAGE_VIEWER_ZOOM_BOUNDS)
}

export function shouldHandleImageZoomWheel(event: ImageZoomWheelEventLike): boolean {
  return shouldHandleSurfaceZoomWheel(event)
}

export function getPinchZoomFactor(deltaY: number, deltaMode: number): number {
  return getSurfacePinchZoomFactor(deltaY, deltaMode)
}

export function getNextWheelImageViewerZoom(
  currentZoom: number,
  deltaY: number,
  deltaMode: number
): number {
  return getNextWheelSurfaceZoom(currentZoom, deltaY, deltaMode, IMAGE_VIEWER_ZOOM_BOUNDS)
}

export function getZoomedImageLayoutSize({
  imageDimensions,
  surfaceSize,
  zoom,
  padding = IMAGE_VIEWER_SURFACE_PADDING
}: {
  imageDimensions: ImageViewerImageDimensions | null
  surfaceSize: ImageViewerSurfaceSize | null
  zoom: number
  padding?: number
}): ImageViewerImageDimensions | null {
  // Why: transformed images do not change scroll extents, so zoom must resize
  // the layout box for popup panning to reach the full image.
  return getZoomedSurfaceLayoutSize({
    contentDimensions: imageDimensions,
    surfaceSize,
    zoom,
    bounds: IMAGE_VIEWER_ZOOM_BOUNDS,
    padding
  })
}

export function getAnchoredImageViewerScrollOffset({
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
  return getAnchoredSurfaceScrollOffset({
    scrollOffset,
    anchorOffset,
    currentZoom,
    nextZoom
  })
}
