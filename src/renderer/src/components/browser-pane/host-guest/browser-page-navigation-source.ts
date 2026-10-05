import { getBrowserDisplayTitle } from '../describe-page/browser-page-url-display'
import type { BrowserTabPageState } from '../describe-page/browser-page-types'

/** Committed guest state used by the shared navigation and loading handlers. */
export type BrowserPageNavigationSource = {
  getURL: () => string
  getTitle: () => string
  canGoBack: () => boolean
  canGoForward: () => boolean
  readonly src: string
}

export type BrowserPageNavigationStart = {
  isMainFrame: boolean
  isInPlace: boolean
  url: string
}

export function readBrowserPageNavigationState(
  source: BrowserPageNavigationSource,
  fallbackUrl: string,
  loading?: boolean
): BrowserTabPageState {
  return {
    title: getBrowserDisplayTitle(source.getTitle(), source.getURL() || fallbackUrl),
    ...(loading === undefined ? {} : { loading }),
    canGoBack: source.canGoBack(),
    canGoForward: source.canGoForward()
  }
}

export function syncBrowserPageNavigationState(
  source: BrowserPageNavigationSource & { isLoading: () => boolean },
  pageId: string,
  fallbackUrl: string,
  loading: boolean,
  update: (pageId: string, state: BrowserTabPageState) => void
): void {
  try {
    update(
      pageId,
      readBrowserPageNavigationState(source, fallbackUrl, loading ? source.isLoading() : undefined)
    )
  } catch {
    // Guest getters can reject before attachment completes.
  }
}
