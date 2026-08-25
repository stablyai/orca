import { redactKagiSessionToken } from '../../../../shared/browser-url'
import type { BrowserClientPageMetadataSnapshot } from './browser-client-page-metadata-publisher'

/**
 * What a client-hosted guest currently is, read straight off the webview.
 *
 * `eventUrl` wins when a navigation event carries one: the tag's own getURL() can still report the
 * previous page while the event is being delivered. `loading` is forced for did-start-loading,
 * which fires before isLoading() flips.
 */
export function readBrowserClientPageGuestMetadata(
  webview: Electron.WebviewTag,
  eventUrl?: string,
  loading?: boolean
): BrowserClientPageMetadataSnapshot {
  const url = redactKagiSessionToken(eventUrl || webview.getURL() || 'about:blank')
  return {
    url,
    title: webview.getTitle() || url || 'Browser',
    loading: loading ?? webview.isLoading(),
    canGoBack: webview.canGoBack(),
    canGoForward: webview.canGoForward()
  }
}
