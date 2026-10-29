import type { BrowserLoadError } from '../../../../shared/browser-workspace-types'
import type { BrowserPageFailLoadEvent } from './describe-page/browser-page-types'
import { resolveBrowserWebviewLoadFailure } from './navigate/browser-webview-load-failure'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import { redactKagiSessionToken } from '../../../../shared/browser-url'
import type { BrowserClientPageMetadataSnapshot } from './browser-client-page-metadata-publisher'

/** Guest methods can throw after main destroys it; return null rather than unwind a React effect. Prefer navigation-event URLs and force loading at start before tag getters catch up. */
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
    // Record unexpected read failures too; the total catch otherwise makes them indistinguishable from guest death.
    console.warn('[browser-client-page] guest read failed, treating the page as gone:', error)
    recordRendererCrashBreadcrumb('browser_client_page_guest_read_failed', {
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error)
    })
    return null
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

/** Binds the guest events a client-hosted pane mirrors and returns the matching unbind. */
export function bindBrowserClientPageGuestEvents(
  webview: Electron.WebviewTag,
  onStart: (event: Electron.DidStartNavigationEvent) => void,
  syncNavigation: (event?: Event) => void,
  onFailLoad: (event: Event) => void
): () => void {
  webview.addEventListener('did-start-navigation', onStart)
  webview.addEventListener('did-stop-loading', syncNavigation)
  webview.addEventListener('did-navigate', syncNavigation)
  webview.addEventListener('did-navigate-in-page', syncNavigation)
  webview.addEventListener('page-title-updated', syncNavigation)
  webview.addEventListener('did-fail-load', onFailLoad)
  return () => {
    webview.removeEventListener('did-start-navigation', onStart)
    webview.removeEventListener('did-stop-loading', syncNavigation)
    webview.removeEventListener('did-navigate', syncNavigation)
    webview.removeEventListener('did-navigate-in-page', syncNavigation)
    webview.removeEventListener('page-title-updated', syncNavigation)
    webview.removeEventListener('did-fail-load', onFailLoad)
  }
}
