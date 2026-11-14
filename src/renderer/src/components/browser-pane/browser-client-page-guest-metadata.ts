import type { BrowserLoadError } from '../../../../shared/browser-workspace-types'
import type { BrowserPageFailLoadEvent } from './describe-page/browser-page-types'
import { resolveBrowserWebviewLoadFailure } from './navigate/browser-webview-load-failure'
import { cachedBrowserGuestMetadata } from './host-guest/browser-guest-metadata-cache'

export function createBrowserClientPageLoadFailureHandler(
  webview: Electron.WebviewTag,
  onFailure: (error: BrowserLoadError) => void
): (event: Event) => void {
  return (event) => {
    const loadError = resolveBrowserWebviewLoadFailure(event as BrowserPageFailLoadEvent, {
      // Discarded ERR_ABORTED/subframe events must not read the guest.
      fallbackUrl: () => {
        return cachedBrowserGuestMetadata(webview)?.url ?? null
      }
    })
    if (loadError) {
      onFailure(loadError)
    }
  }
}
