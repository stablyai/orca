import {
  browserNavigationLeavesFaviconOrigin,
  pickDisplayableFaviconUrl,
  remoteTabFaviconUrl
} from '../../../../../../shared/browser/browser-favicon-url'
import { cachedBrowserGuestMetadata } from '../../host-guest/metadata/browser-guest-metadata-cache'
import type { BrowserTabPageState } from '../../describe-page/browser-page-types'

// The retained guest outlives its pane, so remember which document each guest's icon came from.
const faviconDocumentUrlByGuest = new WeakMap<Electron.WebviewTag, string>()

/** The favicon, address-bar dismissal and viewport preset a local page binds, for a desktop-hosted guest. */
export function bindBrowserClientPageChromeListeners(
  webview: Electron.WebviewTag,
  {
    browserPageId,
    updatePageState,
    publishFavicon,
    dismissAddressBarSuggestions,
    applyViewportPreset
  }: {
    browserPageId: string
    updatePageState: (tabId: string, updates: BrowserTabPageState) => void
    /** Other clients show the icon only once the runtime has it. */
    publishFavicon: (faviconUrl: string | null) => void
    dismissAddressBarSuggestions: () => void
    /** CDP overrides don't survive a cross-origin load, and the guest may have loaded while no pane showed it. */
    applyViewportPreset: (trigger: 'attach' | 'load') => void
  }
): () => void {
  const guestUrl = (): string | null => cachedBrowserGuestMetadata(webview)?.url ?? null
  const clearFavicon = (): void => {
    faviconDocumentUrlByGuest.delete(webview)
    updatePageState(browserPageId, { faviconUrl: null })
    publishFavicon(null)
  }
  // Icon events fired while no pane listened are lost; drop an icon a background navigation left behind.
  const iconDocumentUrl = faviconDocumentUrlByGuest.get(webview)
  if (iconDocumentUrl && browserNavigationLeavesFaviconOrigin(iconDocumentUrl, guestUrl())) {
    clearFavicon()
  }
  const onFavicon = (event: { favicons?: string[] }): void => {
    // The page's loopback is the remote machine's, but the tab strip loads the icon from this one.
    const faviconUrl = remoteTabFaviconUrl(pickDisplayableFaviconUrl(event.favicons))
    const documentUrl = guestUrl()
    if (documentUrl) {
      faviconDocumentUrlByGuest.set(webview, documentUrl)
    }
    updatePageState(browserPageId, { faviconUrl })
    publishFavicon(faviconUrl)
  }
  // Chromium sends no icon update for an icon-less page, so a cross-origin leave clears the old one.
  const onLeaveDocument = (
    event: Electron.DidStartNavigationEvent | Electron.DidRedirectNavigationEvent
  ): void => {
    if (
      event.isMainFrame &&
      !event.isInPlace &&
      event.url &&
      browserNavigationLeavesFaviconOrigin(guestUrl(), event.url)
    ) {
      clearFavicon()
    }
  }
  // Guests never send outside pointer events to the renderer, so a page click can't close suggestions otherwise.
  const onFocus = (): void => dismissAddressBarSuggestions()
  const onDomReady = (): void => applyViewportPreset('load')
  applyViewportPreset('attach')
  webview.addEventListener('dom-ready', onDomReady)
  webview.addEventListener('page-favicon-updated', onFavicon)
  webview.addEventListener('did-start-navigation', onLeaveDocument)
  webview.addEventListener('did-redirect-navigation', onLeaveDocument)
  webview.addEventListener('focus', onFocus)
  return () => {
    webview.removeEventListener('dom-ready', onDomReady)
    webview.removeEventListener('page-favicon-updated', onFavicon)
    webview.removeEventListener('did-start-navigation', onLeaveDocument)
    webview.removeEventListener('did-redirect-navigation', onLeaveDocument)
    webview.removeEventListener('focus', onFocus)
  }
}
