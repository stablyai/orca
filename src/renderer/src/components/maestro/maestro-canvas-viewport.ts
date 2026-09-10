export type MaestroCanvasViewport = {
  center: { x: number; y: number }
  zoom: number
}

export type MaestroCanvasSize = { width: number; height: number }
export type MaestroCanvasBounds = { x: number; y: number; width: number; height: number }
export type MaestroCanvasInsets = { top: number; right: number; bottom: number; left: number }

export const MAESTRO_MIN_ZOOM = 0.025
export const MAESTRO_MAX_ZOOM = 2.5

export function clampMaestroZoom(value: number): number {
  return Math.max(MAESTRO_MIN_ZOOM, Math.min(MAESTRO_MAX_ZOOM, value))
}

export function panMaestroViewport(
  viewport: MaestroCanvasViewport,
  delta: { x: number; y: number }
): MaestroCanvasViewport {
  return {
    ...viewport,
    center: {
      x: viewport.center.x - delta.x / viewport.zoom,
      y: viewport.center.y - delta.y / viewport.zoom
    }
  }
}

function revealAxis(start: number, length: number, minimum: number, maximum: number): number {
  const available = maximum - minimum
  if (length >= available) {
    return minimum + (available - length) / 2
  }
  return Math.max(minimum, Math.min(maximum - length, start))
}

export function revealMaestroCanvasBounds(
  viewport: MaestroCanvasViewport,
  canvas: MaestroCanvasSize,
  bounds: MaestroCanvasBounds,
  insets: MaestroCanvasInsets
): MaestroCanvasViewport {
  const availableWidth = Math.max(1, canvas.width - insets.left - insets.right)
  const availableHeight = Math.max(1, canvas.height - insets.top - insets.bottom)
  const zoom = clampMaestroZoom(
    Math.min(viewport.zoom, availableWidth / bounds.width, availableHeight / bounds.height)
  )
  const screenLeft = canvas.width / 2 + (bounds.x - viewport.center.x) * zoom
  const screenTop = canvas.height / 2 + (bounds.y - viewport.center.y) * zoom
  const screenWidth = bounds.width * zoom
  const screenHeight = bounds.height * zoom
  const revealedLeft = revealAxis(screenLeft, screenWidth, insets.left, canvas.width - insets.right)
  const revealedTop = revealAxis(screenTop, screenHeight, insets.top, canvas.height - insets.bottom)
  const deltaX = screenLeft - revealedLeft
  const deltaY = screenTop - revealedTop
  if (deltaX === 0 && deltaY === 0 && zoom === viewport.zoom) {
    return viewport
  }
  return {
    zoom,
    center: {
      x: viewport.center.x + deltaX / zoom,
      y: viewport.center.y + deltaY / zoom
    }
  }
}

const BOARD_GRID_STEPS = [24, 48, 96, 192, 384, 768] as const
const MIN_ON_SCREEN_GRID_PX = 18

/** Keeps the board's dot spacing readable instead of collapsing into moiré. */
export function maestroBoardGridStep(zoom: number): number {
  return BOARD_GRID_STEPS.find((step) => step * zoom >= MIN_ON_SCREEN_GRID_PX) ?? 192
}

export function zoomMaestroViewportAtPointer(
  viewport: MaestroCanvasViewport,
  canvas: MaestroCanvasSize,
  pointer: { x: number; y: number },
  nextZoom: number
): MaestroCanvasViewport {
  const zoom = clampMaestroZoom(nextZoom)
  if (canvas.width <= 0 || canvas.height <= 0) {
    return { ...viewport, zoom }
  }
  const worldWidth = canvas.width / viewport.zoom
  const worldHeight = canvas.height / viewport.zoom
  const anchor = {
    x: viewport.center.x - worldWidth / 2 + (pointer.x / canvas.width) * worldWidth,
    y: viewport.center.y - worldHeight / 2 + (pointer.y / canvas.height) * worldHeight
  }
  const nextWorldWidth = canvas.width / zoom
  const nextWorldHeight = canvas.height / zoom
  return {
    zoom,
    center: {
      x: anchor.x - (pointer.x / canvas.width - 0.5) * nextWorldWidth,
      y: anchor.y - (pointer.y / canvas.height - 0.5) * nextWorldHeight
    }
  }
}

export function isMaestroCanvasBoundsVisible(
  bounds: MaestroCanvasBounds,
  viewport: MaestroCanvasViewport,
  canvas: MaestroCanvasSize,
  margin = 160
): boolean {
  const left = viewport.center.x - canvas.width / viewport.zoom / 2 - margin
  const top = viewport.center.y - canvas.height / viewport.zoom / 2 - margin
  const right = viewport.center.x + canvas.width / viewport.zoom / 2 + margin
  const bottom = viewport.center.y + canvas.height / viewport.zoom / 2 + margin
  return (
    bounds.x + bounds.width >= left &&
    bounds.x <= right &&
    bounds.y + bounds.height >= top &&
    bounds.y <= bottom
  )
}
