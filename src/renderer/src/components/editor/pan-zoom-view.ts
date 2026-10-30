import {
  IMAGE_VIEWER_SURFACE_PADDING,
  MAX_IMAGE_VIEWER_ZOOM,
  MIN_IMAGE_VIEWER_ZOOM
} from './image-viewer-zoom'

export type PanZoomSize = { width: number; height: number }
export type PanZoomPoint = { x: number; y: number }

/** `center` is the content point, in natural units, shown at the middle of the viewport. */
export type PanZoomView = { zoom: number; center: PanZoomPoint }

export function getPanZoomFitScale(
  content: PanZoomSize,
  viewport: PanZoomSize,
  padding = IMAGE_VIEWER_SURFACE_PADDING
): number {
  const availableWidth = viewport.width - padding * 2
  const availableHeight = viewport.height - padding * 2
  if (content.width <= 0 || content.height <= 0 || availableWidth <= 0 || availableHeight <= 0) {
    return 1
  }
  return Math.min(1, availableWidth / content.width, availableHeight / content.height)
}

export function getFittedPanZoomView(content: PanZoomSize): PanZoomView {
  return { zoom: 1, center: { x: content.width / 2, y: content.height / 2 } }
}

export function getMaxPanZoom(fitScale: number): number {
  // Why: zoom is relative to the fit, so content fitted far below 1 needs more headroom to reach natural size.
  return Math.max(MAX_IMAGE_VIEWER_ZOOM, 1 / fitScale)
}

export function clampPanZoom(zoom: number, fitScale: number): number {
  return Math.min(getMaxPanZoom(fitScale), Math.max(MIN_IMAGE_VIEWER_ZOOM, zoom))
}

function clampPanZoomCenter(center: PanZoomPoint, content: PanZoomSize): PanZoomPoint {
  // Why: keeping the center on the content means it can never be dragged out of reach.
  return {
    x: Math.min(content.width, Math.max(0, center.x)),
    y: Math.min(content.height, Math.max(0, center.y))
  }
}

/** Moves the content by a distance in viewport pixels. */
export function panView(
  view: PanZoomView,
  delta: PanZoomPoint,
  scale: number,
  content: PanZoomSize
): PanZoomView {
  return {
    zoom: view.zoom,
    center: clampPanZoomCenter(
      {
        x: view.center.x - delta.x / scale,
        y: view.center.y - delta.y / scale
      },
      content
    )
  }
}

/** Zooms while keeping the content point under `anchor` (viewport pixels) where it is. */
export function zoomViewAt({
  view,
  nextZoom,
  anchor,
  viewport,
  fitScale,
  content
}: {
  view: PanZoomView
  nextZoom: number
  anchor: PanZoomPoint
  viewport: PanZoomSize
  fitScale: number
  content: PanZoomSize
}): PanZoomView {
  const zoom = clampPanZoom(nextZoom, fitScale)
  const offset = {
    x: anchor.x - viewport.width / 2,
    y: anchor.y - viewport.height / 2
  }
  const scale = fitScale * view.zoom
  const nextScale = fitScale * zoom
  return {
    zoom,
    center: clampPanZoomCenter(
      {
        x: view.center.x + offset.x / scale - offset.x / nextScale,
        y: view.center.y + offset.y / scale - offset.y / nextScale
      },
      content
    )
  }
}

export function getPanZoomViewOffset(
  view: PanZoomView,
  viewport: PanZoomSize,
  scale: number
): PanZoomPoint {
  return {
    x: viewport.width / 2 - view.center.x * scale,
    y: viewport.height / 2 - view.center.y * scale
  }
}
