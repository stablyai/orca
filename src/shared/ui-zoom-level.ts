/** Chromium's zoom-level base: one level step multiplies rendered size by this. */
export const UI_ZOOM_BASE = 1.2

export const UI_ZOOM_STEP = 0.5
export const UI_ZOOM_MIN = -3
export const UI_ZOOM_MAX = 5

export type UIZoomDirection = 'in' | 'out' | 'reset'

export function stepUIZoomLevel(current: number, direction: UIZoomDirection): number {
  if (direction === 'reset') {
    return 0
  }
  const next = direction === 'in' ? current + UI_ZOOM_STEP : current - UI_ZOOM_STEP
  return Math.max(UI_ZOOM_MIN, Math.min(UI_ZOOM_MAX, next))
}

/** CSS pixels × zoom factor = window DIP; convert for traffic lights, OS cursor positions and guest viewports. */
export function uiZoomFactorFromLevel(level: number): number {
  return UI_ZOOM_BASE ** level
}
