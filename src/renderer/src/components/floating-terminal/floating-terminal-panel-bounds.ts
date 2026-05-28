export const DEFAULT_PANEL_WIDTH = 920
export const DEFAULT_PANEL_HEIGHT = 560
export const MIN_PANEL_WIDTH = 420
export const MIN_PANEL_HEIGHT = 280
export const MAXIMIZED_MARGIN = 12
export const MAXIMIZED_BOTTOM_GAP = 36
export const TITLEBAR_SAFE_TOP = 36
const DEFAULT_RIGHT_GAP = 24
const DEFAULT_BOTTOM_GAP = 84

export type FloatingTerminalPanelBounds = {
  left: number
  top: number
  width: number
  height: number
}

export function getDefaultFloatingTerminalBounds(): FloatingTerminalPanelBounds {
  const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight
  // Why: the floating panel may touch the renderer titlebar, but must not
  // overlap it or the native window controls above it.
  const safeTop = TITLEBAR_SAFE_TOP
  const width = Math.min(DEFAULT_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, viewportWidth - 48))
  const height = Math.min(DEFAULT_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, viewportHeight - 96))
  return {
    left: Math.max(16, viewportWidth - width - DEFAULT_RIGHT_GAP),
    top: Math.max(safeTop, viewportHeight - height - DEFAULT_BOTTOM_GAP),
    width,
    height
  }
}

export function clampFloatingTerminalBounds(
  bounds: FloatingTerminalPanelBounds
): FloatingTerminalPanelBounds {
  const viewportWidth =
    typeof window === 'undefined' ? bounds.left + bounds.width : window.innerWidth
  const viewportHeight =
    typeof window === 'undefined' ? bounds.top + bounds.height : window.innerHeight
  const safeTop = TITLEBAR_SAFE_TOP
  return {
    ...bounds,
    left: Math.min(Math.max(8, bounds.left), Math.max(8, viewportWidth - 80)),
    top: Math.min(Math.max(safeTop, bounds.top), Math.max(safeTop, viewportHeight - 80))
  }
}

export function getMaximizedFloatingTerminalBounds(): FloatingTerminalPanelBounds {
  const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight
  const top = TITLEBAR_SAFE_TOP
  return {
    left: MAXIMIZED_MARGIN,
    top,
    width: Math.max(MIN_PANEL_WIDTH, viewportWidth - MAXIMIZED_MARGIN * 2),
    height: Math.max(MIN_PANEL_HEIGHT, viewportHeight - top - MAXIMIZED_BOTTOM_GAP)
  }
}
