import type { SurfaceContentDimensions, SurfaceSize } from './anchored-surface-zoom'
import { getZoomedSurfaceLayoutSize } from './anchored-surface-zoom'

export const MIN_DIAGRAM_SURFACE_ZOOM = 0.25
export const MAX_DIAGRAM_SURFACE_ZOOM = 8
export const DIAGRAM_SURFACE_ZOOM_STEP = 1.25
export const DIAGRAM_SURFACE_PADDING = 24
export const DIAGRAM_SURFACE_ZOOM_BOUNDS = {
  min: MIN_DIAGRAM_SURFACE_ZOOM,
  max: MAX_DIAGRAM_SURFACE_ZOOM
}

export type DiagramSurfaceDimensions = SurfaceContentDimensions
export type DiagramSurfaceSize = SurfaceSize
export type DiagramSurfaceKeyboardZoomIntent = 'zoom-in' | 'zoom-out' | 'reset'

type DiagramSurfaceKeyboardZoomEvent = {
  altKey: boolean
  code: string
  ctrlKey: boolean
  key: string
  metaKey: boolean
}

export type DiagramSurfacePanStart = {
  clientX: number
  clientY: number
  scrollLeft: number
  scrollTop: number
}

export function getDiagramSurfaceKeyboardZoomIntent(
  event: DiagramSurfaceKeyboardZoomEvent,
  platform: NodeJS.Platform
): DiagramSurfaceKeyboardZoomIntent | null {
  const isMac = platform === 'darwin'
  const hasPlatformModifier = isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
  if (!hasPlatformModifier || event.altKey) {
    return null
  }

  if (
    event.key === '+' ||
    event.key === '=' ||
    event.code === 'Equal' ||
    event.code === 'NumpadAdd'
  ) {
    return 'zoom-in'
  }
  if (
    event.key === '-' ||
    event.key === '_' ||
    event.code === 'Minus' ||
    event.code === 'NumpadSubtract'
  ) {
    return 'zoom-out'
  }
  if (event.key === '0' || event.code === 'Digit0' || event.code === 'Numpad0') {
    return 'reset'
  }

  return null
}

export function getDraggedDiagramSurfaceScrollPosition({
  start,
  clientX,
  clientY
}: {
  start: DiagramSurfacePanStart
  clientX: number
  clientY: number
}): { scrollLeft: number; scrollTop: number } {
  return {
    scrollLeft: start.scrollLeft - (clientX - start.clientX),
    scrollTop: start.scrollTop - (clientY - start.clientY)
  }
}

export function getZoomedDiagramLayoutSize({
  diagramDimensions,
  surfaceSize,
  zoom,
  padding = DIAGRAM_SURFACE_PADDING
}: {
  diagramDimensions: DiagramSurfaceDimensions | null
  surfaceSize: DiagramSurfaceSize | null
  zoom: number
  padding?: number
}): DiagramSurfaceDimensions | null {
  return getZoomedSurfaceLayoutSize({
    contentDimensions: diagramDimensions,
    surfaceSize,
    zoom,
    bounds: DIAGRAM_SURFACE_ZOOM_BOUNDS,
    padding
  })
}
