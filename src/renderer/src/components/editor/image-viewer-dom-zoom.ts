import type { CSSProperties, Dispatch, SetStateAction } from 'react'
import {
  type ImageViewerImageDimensions,
  type ImageViewerSurfaceSize,
  type ImageViewerZoomAnchor,
  IMAGE_VIEWER_ZOOM_BOUNDS
} from './image-viewer-zoom'
import {
  applyAnchoredSurfaceZoomChange,
  applySurfaceWheel,
  getElementSurfaceSize as getSurfaceElementSize,
  getSurfaceLayoutStyle
} from './anchored-surface-dom-zoom'

export type ApplyImageViewerZoomChange = (
  getNextZoom: (currentZoom: number) => number,
  anchor?: ImageViewerZoomAnchor | null
) => void

export function getElementSurfaceSize(element: HTMLElement): ImageViewerSurfaceSize {
  return getSurfaceElementSize(element)
}

export function getImageLayoutStyle(
  size: ImageViewerImageDimensions | null
): CSSProperties | undefined {
  return getSurfaceLayoutStyle(size)
}

export function applyAnchoredImageViewerZoomChange(
  surface: HTMLDivElement | null,
  setZoom: Dispatch<SetStateAction<number>>,
  getNextZoom: (currentZoom: number) => number,
  anchor?: ImageViewerZoomAnchor | null
): void {
  applyAnchoredSurfaceZoomChange(surface, setZoom, getNextZoom, IMAGE_VIEWER_ZOOM_BOUNDS, anchor)
}

export function applyImageSurfaceWheel(
  event: WheelEvent,
  applyZoomChange: ApplyImageViewerZoomChange
): void {
  applySurfaceWheel(event, applyZoomChange, IMAGE_VIEWER_ZOOM_BOUNDS)
}
