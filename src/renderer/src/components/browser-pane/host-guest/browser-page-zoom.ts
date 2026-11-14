import type { BrowserPageZoomCommand } from '../../../../../shared/browser-page-zoom'
import type { BrowserPageSiteDisplay } from '../../../../../shared/browser-site-display'

export type { BrowserPageZoomCommand } from '../../../../../shared/browser-page-zoom'

export const ORCA_BROWSER_PAGE_ZOOM_EVENT = 'orca:browser-page-zoom'

/** Zoom chords that land in Orca's own window while a browser pane holds focus. */
export function dispatchBrowserPageZoom(command: BrowserPageZoomCommand): void {
  window.dispatchEvent(new CustomEvent(ORCA_BROWSER_PAGE_ZOOM_EVENT, { detail: command }))
}

export function addBrowserPageZoomEventListener(
  callback: (command: BrowserPageZoomCommand) => void
): () => void {
  const listener = (event: Event): void => {
    if (event instanceof CustomEvent) {
      callback(event.detail)
    }
  }
  window.addEventListener(ORCA_BROWSER_PAGE_ZOOM_EVENT, listener)
  return () => window.removeEventListener(ORCA_BROWSER_PAGE_ZOOM_EVENT, listener)
}

const ORCA_BROWSER_PAGE_SITE_DISPLAY_EVENT = 'orca:browser-page-site-display'

type BrowserPageSiteDisplayUpdate = {
  browserPageId: string
  display: BrowserPageSiteDisplay | null
}

/** Zoom resolves in main with no push event, so whoever changed it tells the page's chrome. */
export function publishBrowserPageSiteDisplay(update: BrowserPageSiteDisplayUpdate): void {
  window.dispatchEvent(new CustomEvent(ORCA_BROWSER_PAGE_SITE_DISPLAY_EVENT, { detail: update }))
}

export function addBrowserPageSiteDisplayListener(
  browserPageId: string,
  callback: (display: BrowserPageSiteDisplay | null) => void
): () => void {
  const listener = (event: Event): void => {
    if (event instanceof CustomEvent && event.detail?.browserPageId === browserPageId) {
      callback(event.detail.display)
    }
  }
  window.addEventListener(ORCA_BROWSER_PAGE_SITE_DISPLAY_EVENT, listener)
  return () => window.removeEventListener(ORCA_BROWSER_PAGE_SITE_DISPLAY_EVENT, listener)
}
