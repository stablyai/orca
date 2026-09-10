import {
  isMaestroCanvasBoundsVisible,
  type MaestroCanvasBounds,
  type MaestroCanvasSize,
  type MaestroCanvasViewport
} from './maestro-canvas-viewport'

export type MaestroWorkspacePreviewMode = 'full' | 'identity' | 'suspended'

const FULL_PREVIEW_ENTER_SIZE_PX = 190
const FULL_PREVIEW_EXIT_SIZE_PX = 150
const VIEWPORT_OVERSCAN_PX = 240

export function maestroWorkspacePreviewMode(params: {
  bounds: MaestroCanvasBounds
  viewport: MaestroCanvasViewport
  canvas: MaestroCanvasSize
  previous?: MaestroWorkspacePreviewMode
  selected?: boolean
}): MaestroWorkspacePreviewMode {
  const { bounds, viewport, canvas } = params
  const overscanWorldUnits = VIEWPORT_OVERSCAN_PX / viewport.zoom
  if (!isMaestroCanvasBoundsVisible(bounds, viewport, canvas, overscanWorldUnits)) {
    return 'suspended'
  }
  if (params.selected) {
    return 'full'
  }
  const minimumScreenSize = Math.min(bounds.width, bounds.height) * viewport.zoom
  const fullThreshold =
    params.previous === 'full' ? FULL_PREVIEW_EXIT_SIZE_PX : FULL_PREVIEW_ENTER_SIZE_PX
  return minimumScreenSize >= fullThreshold ? 'full' : 'identity'
}
