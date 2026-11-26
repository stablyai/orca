import type { BrowserGuestDocumentEvent } from '../../../../../shared/browser/annotations/browser-guest-document-event'
import { isPageDocumentNavigationStart } from '../host-guest/lifecycle/browser-page-webview-navigation-handlers'

/** Feeds a webview's document events to annotate, as the page's host does for a streamed page. */
export function bindGuestAnnotationDocument(
  webview: Electron.WebviewTag,
  onEvent: (event: BrowserGuestDocumentEvent) => void
): () => void {
  const onConsoleMessage = (event: { message?: string }): void =>
    onEvent({ type: 'viewport', message: event.message ?? '' })
  const onStartNavigation = (event: Electron.DidStartNavigationEvent): void => {
    if (isPageDocumentNavigationStart(event)) {
      onEvent({ type: 'documentStart' })
    }
  }
  const onNavigate = (event: { url?: string; isMainFrame?: boolean }): void => {
    if (event.isMainFrame !== false && event.url) {
      onEvent({ type: 'navigated', url: event.url })
    }
  }
  const onDomReady = (): void => onEvent({ type: 'domReady' })
  webview.addEventListener('console-message', onConsoleMessage)
  webview.addEventListener('did-start-navigation', onStartNavigation)
  webview.addEventListener('did-navigate', onNavigate)
  webview.addEventListener('did-navigate-in-page', onNavigate)
  webview.addEventListener('dom-ready', onDomReady)
  return () => {
    webview.removeEventListener('console-message', onConsoleMessage)
    webview.removeEventListener('did-start-navigation', onStartNavigation)
    webview.removeEventListener('did-navigate', onNavigate)
    webview.removeEventListener('did-navigate-in-page', onNavigate)
    webview.removeEventListener('dom-ready', onDomReady)
  }
}
