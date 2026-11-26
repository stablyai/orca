import { BROWSER_PAGE_ZOOM_LEVELS } from '../../browser/site-settings/browser-page-zoom'

/** Chromium's zoom-level base: one level step multiplies rendered size by this. */
export const UI_ZOOM_BASE = 1.2

export const UI_ZOOM_MIN = -3
export const UI_ZOOM_MAX = 5

// Levels this close count as the same stop, so float noise in a saved level never skips one.
const STOP_EPSILON = 1e-6

/** The round percents the built-in browser's zoom uses, inside the UI range, with its ends as the outer stops. */
const UI_ZOOM_STOPS: readonly number[] = [
  UI_ZOOM_MIN,
  ...BROWSER_PAGE_ZOOM_LEVELS.filter(
    (level) => level > UI_ZOOM_MIN + STOP_EPSILON && level < UI_ZOOM_MAX - STOP_EPSILON
  ),
  UI_ZOOM_MAX
]

export type UIZoomDirection = 'in' | 'out' | 'reset'

/** The next stop in `direction`; a level between two stops (an older saved one, or a typed one) moves to the nearer stop that way. */
export function stepUIZoomLevel(current: number, direction: UIZoomDirection): number {
  if (direction === 'reset') {
    return 0
  }
  if (direction === 'in') {
    return UI_ZOOM_STOPS.find((stop) => stop > current + STOP_EPSILON) ?? UI_ZOOM_MAX
  }
  for (let index = UI_ZOOM_STOPS.length - 1; index >= 0; index--) {
    if (UI_ZOOM_STOPS[index] < current - STOP_EPSILON) {
      return UI_ZOOM_STOPS[index]
    }
  }
  return UI_ZOOM_MIN
}

/** CSS pixels × zoom factor = window DIP; convert for traffic lights, OS cursor positions and guest viewports. */
export function uiZoomFactorFromLevel(level: number): number {
  return UI_ZOOM_BASE ** level
}

export function zoomLevelToPercent(level: number): number {
  return Math.round(100 * uiZoomFactorFromLevel(level))
}

/** The level for a typed percentage, clamped to the UI range; null when the text is not a positive number. */
export function percentTextToZoomLevel(text: string): number | null {
  const percent = Number(text.trim())
  if (!text.trim() || !Number.isFinite(percent) || percent <= 0) {
    return null
  }
  const level = Math.log(percent / 100) / Math.log(UI_ZOOM_BASE)
  return Math.max(UI_ZOOM_MIN, Math.min(UI_ZOOM_MAX, level))
}
