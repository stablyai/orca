import {
  IMAGE_VIEWER_SURFACE_PADDING,
  MAX_IMAGE_VIEWER_ZOOM,
  MIN_IMAGE_VIEWER_ZOOM
} from './image-viewer-zoom'

export type DiagramSize = { width: number; height: number }
export type DiagramPoint = { x: number; y: number }

/** `center` is the diagram point, in natural units, shown at the middle of the viewport. */
export type DiagramView = { zoom: number; center: DiagramPoint }

export function getDiagramFitScale(
  diagram: DiagramSize,
  viewport: DiagramSize,
  padding = IMAGE_VIEWER_SURFACE_PADDING
): number {
  const availableWidth = viewport.width - padding * 2
  const availableHeight = viewport.height - padding * 2
  if (diagram.width <= 0 || diagram.height <= 0 || availableWidth <= 0 || availableHeight <= 0) {
    return 1
  }
  return Math.min(1, availableWidth / diagram.width, availableHeight / diagram.height)
}

export function getFittedDiagramView(diagram: DiagramSize): DiagramView {
  return { zoom: 1, center: { x: diagram.width / 2, y: diagram.height / 2 } }
}

export function getMaxDiagramZoom(fitScale: number): number {
  // Why: zoom is relative to the fit, so a diagram fitted far below 1 needs more headroom to reach natural size.
  return Math.max(MAX_IMAGE_VIEWER_ZOOM, 1 / fitScale)
}

export function clampDiagramZoom(zoom: number, fitScale: number): number {
  return Math.min(getMaxDiagramZoom(fitScale), Math.max(MIN_IMAGE_VIEWER_ZOOM, zoom))
}

function clampDiagramCenter(center: DiagramPoint, diagram: DiagramSize): DiagramPoint {
  // Why: keeping the center on the diagram means it can never be dragged out of reach.
  return {
    x: Math.min(diagram.width, Math.max(0, center.x)),
    y: Math.min(diagram.height, Math.max(0, center.y))
  }
}

/** Moves the diagram by a distance in viewport pixels. */
export function panDiagramView(
  view: DiagramView,
  delta: DiagramPoint,
  scale: number,
  diagram: DiagramSize
): DiagramView {
  return {
    zoom: view.zoom,
    center: clampDiagramCenter(
      { x: view.center.x - delta.x / scale, y: view.center.y - delta.y / scale },
      diagram
    )
  }
}

/** Zooms while keeping the diagram point under `anchor` (viewport pixels) where it is. */
export function zoomDiagramViewAt({
  view,
  nextZoom,
  anchor,
  viewport,
  fitScale,
  diagram
}: {
  view: DiagramView
  nextZoom: number
  anchor: DiagramPoint
  viewport: DiagramSize
  fitScale: number
  diagram: DiagramSize
}): DiagramView {
  const zoom = clampDiagramZoom(nextZoom, fitScale)
  const offset = { x: anchor.x - viewport.width / 2, y: anchor.y - viewport.height / 2 }
  const scale = fitScale * view.zoom
  const nextScale = fitScale * zoom
  return {
    zoom,
    center: clampDiagramCenter(
      {
        x: view.center.x + offset.x / scale - offset.x / nextScale,
        y: view.center.y + offset.y / scale - offset.y / nextScale
      },
      diagram
    )
  }
}

/** Top-left of the scaled diagram inside the viewport. */
export function getDiagramViewOffset(
  view: DiagramView,
  viewport: DiagramSize,
  scale: number
): DiagramPoint {
  return {
    x: viewport.width / 2 - view.center.x * scale,
    y: viewport.height / 2 - view.center.y * scale
  }
}
