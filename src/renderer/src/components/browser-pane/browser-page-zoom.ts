export type BrowserPageZoomDirection = 'in' | 'out' | 'reset'

export const ORCA_BROWSER_PAGE_ZOOM_EVENT = 'orca:browser-page-zoom'

export type BrowserPageZoomEventDetail = {
  browserPageId: string
  direction: BrowserPageZoomDirection
}

type BrowserPageZoomWebview = {
  getZoomLevel: () => number
  setZoomLevel: (level: number) => void
  isDestroyed?: () => boolean
}

const BROWSER_PAGE_ZOOM_STEP = 0.5
const BROWSER_PAGE_ZOOM_MIN = -3
const BROWSER_PAGE_ZOOM_MAX = 5
const BROWSER_PAGE_ZOOM_RESET = 0

export function browserPageZoomLevelToPercent(level: number): number {
  // Why: Electron zoom levels are exponential; show the same percentage users
  // expect from Chromium browser zoom controls.
  return Math.round(100 * Math.pow(1.2, level))
}

export function nextBrowserPageZoomLevel(
  current: number,
  direction: BrowserPageZoomDirection
): number {
  const rawNext =
    direction === 'in'
      ? current + BROWSER_PAGE_ZOOM_STEP
      : direction === 'out'
        ? current - BROWSER_PAGE_ZOOM_STEP
        : BROWSER_PAGE_ZOOM_RESET

  return Math.max(BROWSER_PAGE_ZOOM_MIN, Math.min(BROWSER_PAGE_ZOOM_MAX, rawNext))
}

export function applyBrowserPageZoom(
  webview: BrowserPageZoomWebview | null | undefined,
  direction: BrowserPageZoomDirection
): number | null {
  try {
    if (!webview || webview.isDestroyed?.()) {
      return null
    }
    const next = nextBrowserPageZoomLevel(webview.getZoomLevel(), direction)
    webview.setZoomLevel(next)
    return next
  } catch {
    return null
  }
}

export function dispatchBrowserPageZoomEvent(detail: BrowserPageZoomEventDetail): void {
  window.dispatchEvent(
    new CustomEvent<BrowserPageZoomEventDetail>(ORCA_BROWSER_PAGE_ZOOM_EVENT, {
      detail
    })
  )
}

export function addBrowserPageZoomEventListener(
  callback: (detail: BrowserPageZoomEventDetail) => void
): () => void {
  const listener = (event: Event): void => {
    callback((event as CustomEvent<BrowserPageZoomEventDetail>).detail)
  }
  window.addEventListener(ORCA_BROWSER_PAGE_ZOOM_EVENT, listener)
  return () => window.removeEventListener(ORCA_BROWSER_PAGE_ZOOM_EVENT, listener)
}
