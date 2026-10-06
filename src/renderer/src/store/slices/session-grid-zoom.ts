// Shared by the setter, the hydration sanitizer and the toolbar slider so a persisted value
// (hand-edited profile, another client) can never land outside what the slider can express.
export const SESSION_GRID_ZOOM_MIN = 0.7
export const SESSION_GRID_ZOOM_MAX = 1.3
export const SESSION_GRID_ZOOM_DEFAULT = 1

export function clampSessionGridZoom(zoom: number): number {
  return Math.min(
    SESSION_GRID_ZOOM_MAX,
    Math.max(SESSION_GRID_ZOOM_MIN, Number.isFinite(zoom) ? zoom : SESSION_GRID_ZOOM_DEFAULT)
  )
}
