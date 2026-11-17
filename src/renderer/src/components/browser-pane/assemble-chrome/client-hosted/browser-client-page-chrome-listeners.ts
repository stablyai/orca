import {
  browserNavigationLeavesFaviconOrigin,
  pickDisplayableFaviconUrl
} from '../../../../../../shared/browser/browser-favicon-url'
import { cachedBrowserGuestMetadata } from '../../host-guest/metadata/browser-guest-metadata-cache'
import type { BrowserTabPageState } from '../../describe-page/browser-page-types'

/** The favicon, address-bar dismissal and viewport preset a local page binds, for a desktop-hosted guest. */
export function bindBrowserClientPageChromeListeners(
  webview: Electron.WebviewTag,
  {
    browserPageId,
    updatePageState,
    dismissAddressBarSuggestions,
    applyViewportPreset
  }: {
    browserPageId: string
    updatePageState: (tabId: string, updates: BrowserTabPageState) => void
    dismissAddressBarSuggestions: () => void
    /** CDP overrides don't survive a cross-origin load, and the guest may have loaded while no pane showed it. */
    applyViewportPreset: () => void
  }
): () => void {
  const onFavicon = (event: { favicons?: string[] }): void => {
    updatePageState(browserPageId, { faviconUrl: pickDisplayableFaviconUrl(event.favicons) })
  }
  // Chromium sends no icon update for an icon-less page, so a cross-origin leave clears the old one.
  const onStartNavigation = (event: Electron.DidStartNavigationEvent): void => {
    if (!event.isMainFrame || event.isInPlace || !event.url) {
      return
    }
    if (
      browserNavigationLeavesFaviconOrigin(
        cachedBrowserGuestMetadata(webview)?.url ?? null,
        event.url
      )
    ) {
      updatePageState(browserPageId, { faviconUrl: null })
    }
  }
  // Guests never send outside pointer events to the renderer, so a page click can't close suggestions otherwise.
  const onFocus = (): void => dismissAddressBarSuggestions()
  applyViewportPreset()
  webview.addEventListener('dom-ready', applyViewportPreset)
  webview.addEventListener('page-favicon-updated', onFavicon)
  webview.addEventListener('did-start-navigation', onStartNavigation)
  webview.addEventListener('focus', onFocus)
  return () => {
    webview.removeEventListener('dom-ready', applyViewportPreset)
    webview.removeEventListener('page-favicon-updated', onFavicon)
    webview.removeEventListener('did-start-navigation', onStartNavigation)
    webview.removeEventListener('focus', onFocus)
  }
}
