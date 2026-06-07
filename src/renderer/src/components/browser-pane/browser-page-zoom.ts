import {
  DEFAULT_BROWSER_PAGE_ZOOM_LEVEL,
  nextBrowserPageZoomLevel,
  normalizeBrowserPageZoomLevel,
  type BrowserPageZoomDirection
} from '../../../../shared/browser-page-zoom'

export {
  BROWSER_PAGE_ZOOM_LEVELS,
  DEFAULT_BROWSER_PAGE_ZOOM_LEVEL,
  browserPageZoomLevelToPercent,
  nextBrowserPageZoomLevel,
  normalizeBrowserPageZoomLevel,
  type BrowserPageZoomDirection
} from '../../../../shared/browser-page-zoom'

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

export function applyBrowserPageZoom(
  webview: BrowserPageZoomWebview | null | undefined,
  direction: BrowserPageZoomDirection,
  resetLevel: number = DEFAULT_BROWSER_PAGE_ZOOM_LEVEL
): number | null {
  try {
    if (!webview || webview.isDestroyed?.()) {
      return null
    }
    const next = nextBrowserPageZoomLevel(webview.getZoomLevel(), direction, resetLevel)
    webview.setZoomLevel(next)
    return next
  } catch {
    return null
  }
}

export function setBrowserPageZoomLevel(
  webview: BrowserPageZoomWebview | null | undefined,
  level: number
): number | null {
  try {
    if (!webview || webview.isDestroyed?.()) {
      return null
    }
    const next = normalizeBrowserPageZoomLevel(level)
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
