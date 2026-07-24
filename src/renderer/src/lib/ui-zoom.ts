const isMac = navigator.userAgent.includes('Mac')
const hasNativeWindowChrome = isMac || navigator.userAgent.includes('Windows')

/**
 * Apply a UI zoom level change: sets webFrame zoom via the preload API,
 * updates the CSS variable used to compensate native chrome, and keeps
 * native macOS/Windows window controls aligned with the zoomed titlebar.
 */
export function applyUIZoom(level: number): void {
  const zoomFactor = Math.pow(1.2, level)
  window.api.ui.setZoomLevel(level)
  document.documentElement.style.setProperty('--ui-zoom-factor', String(zoomFactor))
  if (hasNativeWindowChrome) {
    window.api.ui.syncWindowChrome(zoomFactor)
  }
}

/**
 * Sync the CSS variable with the current webFrame zoom level.
 * Call on startup after the main process has restored the zoom.
 */
export function syncZoomCSSVar(): void {
  const level = window.api.ui.getZoomLevel()
  const zoomFactor = Math.pow(1.2, level)
  document.documentElement.style.setProperty('--ui-zoom-factor', String(zoomFactor))
  if (hasNativeWindowChrome) {
    window.api.ui.syncWindowChrome(zoomFactor)
  }
}
