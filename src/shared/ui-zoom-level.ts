export const UI_ZOOM_STEP = 0.5
export const UI_ZOOM_MIN = -3
export const UI_ZOOM_MAX = 5

export type UIZoomDirection = 'in' | 'out' | 'reset'

/** Step an Electron zoom level one increment in the given direction, clamped
 *  to the app's supported range. 'reset' returns the 100% level. */
export function stepUIZoomLevel(current: number, direction: UIZoomDirection): number {
  if (direction === 'reset') {
    return 0
  }
  const next = direction === 'in' ? current + UI_ZOOM_STEP : current - UI_ZOOM_STEP
  return Math.max(UI_ZOOM_MIN, Math.min(UI_ZOOM_MAX, next))
}
