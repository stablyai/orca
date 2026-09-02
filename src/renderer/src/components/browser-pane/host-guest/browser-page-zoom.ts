import {
  DEFAULT_BROWSER_PAGE_ZOOM_LEVEL,
  nextBrowserPageZoomLevel,
  normalizeBrowserPageZoomLevel,
  type BrowserPageZoomDirection
} from '../../../../../shared/browser-page-zoom'

export {
  BROWSER_PAGE_ZOOM_LEVELS,
  DEFAULT_BROWSER_PAGE_ZOOM_LEVEL,
  browserPageZoomLevelToPercent,
  nextBrowserPageZoomLevel,
  normalizeBrowserPageZoomLevel,
  type BrowserPageZoomDirection
} from '../../../../../shared/browser-page-zoom'

export const ORCA_BROWSER_PAGE_ZOOM_EVENT = 'orca:browser-page-zoom'

export type BrowserPageZoomEventDetail = {
  browserPageId: string
  direction: BrowserPageZoomDirection
}

export type BrowserPageZoomIndicatorState = {
  ariaHidden: boolean
  opacityClassName: 'opacity-100' | 'opacity-0'
}

export type BrowserPageZoomIndicatorInput = {
  feedbackVisible: boolean
  isDefaultZoom: boolean
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
    // Why compare first: Chromium's HostZoomMap is keyed by host per partition,
    // so a no-op write still overwrites the host-wide zoom a sibling tab on the
    // same hostname set. Only write when this pane actually needs to move.
    if (normalizeBrowserPageZoomLevel(webview.getZoomLevel()) === next) {
      return next
    }
    webview.setZoomLevel(next)
    return next
  } catch {
    return null
  }
}

// Why module-level: the guest webview outlives its React pane (a worktree
// switch or a Settings visit unmounts the chrome and parks the viewport), so a
// pane-local ref re-seeds from the shared Settings default on every remount and
// retroactively hijacks a tab the user already zoomed.
const explicitPaneZoomLevels = new Map<string, number>()

/** The level this tab holds because the USER zoomed it, or null while it is
 *  still sitting on the configured new-tab seed. */
export function getExplicitBrowserPageZoomLevel(browserPageId: string): number | null {
  return explicitPaneZoomLevels.get(browserPageId) ?? null
}

export function rememberExplicitBrowserPageZoomLevel(browserPageId: string, level: number): void {
  explicitPaneZoomLevels.set(browserPageId, level)
}

export function forgetExplicitBrowserPageZoomLevel(browserPageId: string): void {
  explicitPaneZoomLevels.delete(browserPageId)
}

export function getBrowserPageZoomIndicatorState({
  feedbackVisible
}: BrowserPageZoomIndicatorInput): BrowserPageZoomIndicatorState {
  // Why: browser zoom percent is transient feedback; non-default page zoom
  // should not leave a permanent badge over the webview.
  return {
    ariaHidden: !feedbackVisible,
    opacityClassName: feedbackVisible ? 'opacity-100' : 'opacity-0'
  }
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
