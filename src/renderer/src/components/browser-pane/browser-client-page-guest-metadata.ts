import type { BrowserLoadError } from '../../../../shared/browser-workspace-types'
import type { BrowserPageFailLoadEvent } from './describe-page/browser-page-types'
import { resolveBrowserWebviewLoadFailure } from './navigate/browser-webview-load-failure'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { redactKagiSessionToken } from '../../../../shared/browser-url'
import type { BrowserClientPageMetadataSnapshot } from './browser-client-page-metadata-publisher'

/**
 * What a client-hosted guest currently is, read straight off the webview, or null once the tag
 * can no longer reach its guest.
 *
 * `eventUrl` wins when a navigation event carries one: the tag's own getURL() can still report the
 * previous page while the event is being delivered. `loading` is forced for did-start-loading,
 * which fires before isLoading() flips.
 *
 * Why total rather than throwing: a guest destroyed in main leaves the tag holding its id, so
 * every method on it throws `Invalid guestInstanceId` from then on — and every caller reads from
 * a React effect, where that unwinds the whole workbench error boundary.
 */
export function readBrowserClientPageGuestMetadataIfLive(
  webview: Electron.WebviewTag,
  eventUrl?: string,
  loading?: boolean
): BrowserClientPageMetadataSnapshot | null {
  try {
    const url = redactKagiSessionToken(eventUrl || webview.getURL() || 'about:blank')
    return {
      url,
      title: webview.getTitle() || url || 'Browser',
      loading: loading ?? webview.isLoading(),
      canGoBack: webview.canGoBack(),
      canGoForward: webview.canGoForward()
    }
  } catch (error) {
    // Why recorded: the catch is total, so a read failure that is NOT guest death would otherwise
    // be indistinguishable from one — the breadcrumb carries the error text the console cannot.
    console.warn('[browser-client-page] guest read failed, treating the page as gone:', error)
    recordRendererCrashBreadcrumb('browser_client_page_guest_read_failed', {
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

/**
 * Detaches a `<webview>` without letting a removal failure escape.
 *
 * Why total: removing the tag runs Electron's `disconnectedCallback`, which reaches into the
 * guest to tear it down — unverified whether a dead guest (see the module doc above) makes that
 * throw synchronously out of `.remove()` here, since Blink reports custom-element callback
 * exceptions globally rather than rethrowing them to the caller. Kept defensive regardless: every
 * caller is a cleanup path (registry eviction, pane disconnect) invoked from a React effect or
 * event handler, where any throw that does reach here would unwind the workbench error boundary.
 */
export function removeBrowserClientPageWebview(webview: Pick<Electron.WebviewTag, 'remove'>): void {
  try {
    webview.remove()
  } catch (error) {
    console.warn('[browser-client-page] webview removal threw, continuing teardown:', error)
    recordRendererCrashBreadcrumb('browser_client_page_webview_removal_failed', {
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error)
    })
  }
}

export function createBrowserClientPageLoadFailureHandler(
  webview: Electron.WebviewTag,
  onUnavailable: () => void,
  onFailure: (error: BrowserLoadError) => void
): (event: Event) => void {
  return (event) => {
    let guestUnavailable = false
    const loadError = resolveBrowserWebviewLoadFailure(event as BrowserPageFailLoadEvent, {
      // Discarded ERR_ABORTED/subframe events must not read the guest.
      fallbackUrl: () => {
        const metadata = readBrowserClientPageGuestMetadataIfLive(webview)
        guestUnavailable = metadata === null
        return metadata?.url ?? null
      }
    })
    if (guestUnavailable) {
      onUnavailable()
    } else if (loadError) {
      onFailure(loadError)
    }
  }
}
