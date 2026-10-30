import { uiZoomFactorFromLevel } from '../../../shared/ui-zoom-level'

const isMac = navigator.userAgent.includes('Mac')

/** Mirror UI zoom for fixed-DIP CSS compensation, including main.css traffic-light padding. */
const UI_ZOOM_FACTOR_CSS_VAR = '--ui-zoom-factor'

/** Scale applied to this renderer's CSS pixels, or the persisted level in the web client. */
export function getUIZoomFactor(): number {
  return uiZoomFactorFromLevel(window.api?.ui?.getZoomLevel?.() ?? 0)
}

/** Convert window DIP to CSS pixels for exact native-sized boxes, such as emulated guest viewports. */
export function windowDipToCssPx(dip: number): number {
  return dip / getUIZoomFactor()
}

function publishZoomFactor(zoomFactor: number): void {
  document.documentElement.style.setProperty(UI_ZOOM_FACTOR_CSS_VAR, String(zoomFactor))
  if (isMac) {
    window.api.ui.syncTrafficLights(zoomFactor)
  }
}

/** Update webFrame zoom, compensating CSS and native macOS traffic-light positioning together. */
export function applyUIZoom(level: number): void {
  window.api.ui.setZoomLevel(level)
  publishZoomFactor(uiZoomFactorFromLevel(level))
}

/** Sync CSS after main restores webFrame zoom at startup. */
export function syncZoomCSSVar(): void {
  publishZoomFactor(getUIZoomFactor())
}
