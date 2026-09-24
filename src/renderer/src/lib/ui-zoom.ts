import { uiZoomFactorFromLevel } from '../../../shared/ui-zoom-level'

const isMac = navigator.userAgent.includes('Mac')

/** Mirrors the live UI zoom factor so stylesheets can compensate a box that has
 *  to hold a fixed window-DIP size (see `main.css`'s traffic-light pad). */
const UI_ZOOM_FACTOR_CSS_VAR = '--ui-zoom-factor'

/** Scale applied to this renderer's CSS pixels, or the persisted level in the web client. */
function getUIZoomFactor(): number {
  return uiZoomFactorFromLevel(window.api?.ui?.getZoomLevel?.() ?? 0)
}

/** Window DIP -> renderer CSS px. Use when laying out a DOM box that has to
 *  land on an exact native size, such as an emulated guest viewport. */
export function windowDipToCssPx(dip: number): number {
  return dip / getUIZoomFactor()
}

function publishZoomFactor(zoomFactor: number): void {
  document.documentElement.style.setProperty(UI_ZOOM_FACTOR_CSS_VAR, String(zoomFactor))
  if (isMac) {
    window.api.ui.syncTrafficLights(zoomFactor)
  }
}

/**
 * Apply a UI zoom level change: sets webFrame zoom via the preload API,
 * updates the CSS variable used to compensate the traffic-light pad,
 * and repositions the native macOS traffic lights to stay aligned.
 */
export function applyUIZoom(level: number): void {
  window.api.ui.setZoomLevel(level)
  publishZoomFactor(uiZoomFactorFromLevel(level))
}

/**
 * Sync the CSS variable with the current webFrame zoom level.
 * Call on startup after the main process has restored the zoom.
 */
export function syncZoomCSSVar(): void {
  publishZoomFactor(getUIZoomFactor())
}
