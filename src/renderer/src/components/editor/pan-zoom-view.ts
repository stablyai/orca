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
  padding = IMAGE_VIEWER_SURFACE_PADDING,
  upscale = false
): number {
  const availableWidth = viewport.width - padding * 2
  const availableHeight = viewport.height - padding * 2
  if (content.width <= 0 || content.height <= 0 || availableWidth <= 0 || availableHeight <= 0) {
    return 1
  }
  const fill = Math.min(availableWidth / content.width, availableHeight / content.height)
  return upscale ? fill : Math.min(1, fill)
}

export function getFittedPanZoomView(content: PanZoomSize): PanZoomView {
  return { zoom: 1, center: { x: content.width / 2, y: content.height / 2 } }
}

export function getMaxPanZoom(fitScale: number): number {
  // Why: zoom is relative to the fit, so content fitted far below 1 needs more headroom to reach natural size.
  return Math.max(MAX_IMAGE_VIEWER_ZOOM, 1 / fitScale)
}

export function getMinPanZoom(fitScale: number): number {
  // Why: a vector fitted far above its natural size must still be able to reach actual size.
  return Math.min(MIN_IMAGE_VIEWER_ZOOM, 1 / fitScale)
}

export function clampPanZoom(zoom: number, fitScale: number): number {
  return Math.min(getMaxPanZoom(fitScale), Math.max(getMinPanZoom(fitScale), zoom))
}

/** With `visible`, content stops at the viewport edges and stays centered while it fits. */
function clampAxis(center: number, content: number, visible: number | null): number {
  if (visible === null) {
    // Keeping the center on the content means it can never be dragged out of reach.
    return Math.min(content, Math.max(0, center))
  }
  if (content <= visible) {
    return content / 2
  }
  return Math.min(content - visible / 2, Math.max(visible / 2, center))
}

function clampPanZoomCenter(
  center: PanZoomPoint,
  content: PanZoomSize,
  containIn: PanZoomSize | null,
  scale: number
): PanZoomPoint {
  return {
    x: clampAxis(center.x, content.width, containIn && containIn.width / scale),
    y: clampAxis(center.y, content.height, containIn && containIn.height / scale)
  }
}

/** Moves the content by a distance in viewport pixels. */
export function panView(
  view: PanZoomView,
  delta: PanZoomPoint,
  scale: number,
  content: PanZoomSize,
  /** The viewport to keep the content's edges inside, or null to only keep it reachable. */
  containIn: PanZoomSize | null = null
): PanZoomView {
  return {
    zoom: view.zoom,
    center: clampPanZoomCenter(
      {
        x: view.center.x - delta.x / scale,
        y: view.center.y - delta.y / scale
      },
      content,
      containIn,
      scale
    )
  }
}

/** Zooms while keeping the content point under `anchor` (viewport pixels) where it is. */
export function zoomViewAt({
  view,
  nextZoom,
  anchor,
  target = anchor,
  viewport,
  fitScale,
  content,
  contain = false
}: {
  view: PanZoomView
  nextZoom: number
  anchor: PanZoomPoint
  /** Where the content under `anchor` ends up; a pinch whose fingers moved lands it at their new midpoint. */
  target?: PanZoomPoint
  viewport: PanZoomSize
  fitScale: number
  content: PanZoomSize
  contain?: boolean
}): PanZoomView {
  const zoom = clampPanZoom(nextZoom, fitScale)
  const from = { x: anchor.x - viewport.width / 2, y: anchor.y - viewport.height / 2 }
  const to = { x: target.x - viewport.width / 2, y: target.y - viewport.height / 2 }
  const scale = fitScale * view.zoom
  const nextScale = fitScale * zoom
  return {
    zoom,
    center: clampPanZoomCenter(
      {
        x: view.center.x + from.x / scale - to.x / nextScale,
        y: view.center.y + from.y / scale - to.y / nextScale
      },
      content,
      contain ? viewport : null,
      nextScale
    )
  }
}

/** Re-applies edge containment after the viewport or fit changed, e.g. on rotation or a pane resize. */
export function containPanZoomView(
  view: PanZoomView,
  { content, viewport, fitScale }: { content: PanZoomSize; viewport: PanZoomSize; fitScale: number }
): PanZoomView {
  const scale = fitScale * view.zoom
  return { zoom: view.zoom, center: clampPanZoomCenter(view.center, content, viewport, scale) }
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
