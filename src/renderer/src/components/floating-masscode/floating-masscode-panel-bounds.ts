const PANEL_WIDTH = 750
const PANEL_HEIGHT = 500
const MIN_PANEL_WIDTH = 320
const MIN_PANEL_HEIGHT = 280
const MIN_VISIBLE_EDGE = 80
const TITLEBAR_SAFE_TOP = 36
const DEFAULT_RIGHT_GAP = 24
const DEFAULT_BOTTOM_GAP = 84
const MAXIMIZED_MARGIN = 12
const MAXIMIZED_BOTTOM_GAP = 36

export type FloatingMassCodePanelBounds = {
  left: number
  top: number
  width: number
  height: number
}

export function getDefaultFloatingMassCodeBounds(): FloatingMassCodePanelBounds {
  const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight
  const width = Math.min(PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, viewportWidth - 32))
  const height = Math.min(PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, viewportHeight - 72))
  return {
    left: Math.max(16, viewportWidth - width - DEFAULT_RIGHT_GAP),
    top: Math.max(TITLEBAR_SAFE_TOP, viewportHeight - height - DEFAULT_BOTTOM_GAP),
    width,
    height
  }
}

export function clampFloatingMassCodeBounds(
  bounds: FloatingMassCodePanelBounds
): FloatingMassCodePanelBounds {
  const viewportWidth =
    typeof window === 'undefined' ? bounds.left + bounds.width : window.innerWidth
  const viewportHeight =
    typeof window === 'undefined' ? bounds.top + bounds.height : window.innerHeight
  return {
    ...bounds,
    left: Math.min(Math.max(8, bounds.left), Math.max(8, viewportWidth - MIN_VISIBLE_EDGE)),
    top: Math.min(
      Math.max(TITLEBAR_SAFE_TOP, bounds.top),
      Math.max(TITLEBAR_SAFE_TOP, viewportHeight - MIN_VISIBLE_EDGE)
    )
  }
}

export function getMaximizedFloatingMassCodeBounds(): FloatingMassCodePanelBounds {
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
