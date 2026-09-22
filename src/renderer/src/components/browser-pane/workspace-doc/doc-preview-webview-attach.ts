import { DOC_PREVIEW_PARTITION } from '../../../../../shared/doc-preview-scheme'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE } from '../../../../../shared/browser-guest-web-preferences'
import {
  moveFocusToRendererBeforeWebviewDetach,
  registerPersistentWebview,
  unregisterPersistentWebview,
  webviewRegistry
} from '@/components/browser-pane/host-guest/webview-registry'

export function attachDocPreviewWebview({
  previewId,
  container,
  url,
  ariaLabel,
  onLoadStarted,
  onLoadStopped,
  onLoadFailed,
  onNavigated,
  onTitleUpdated
}: {
  previewId: string
  container: HTMLDivElement
  url: string
  ariaLabel: string
  onLoadStarted: () => void
  onLoadStopped: () => void
  onLoadFailed: (event: Electron.DidFailLoadEvent) => void
  onNavigated: () => void
  onTitleUpdated: (event: Electron.PageTitleUpdatedEvent) => void
}): { webview: Electron.WebviewTag; detach: () => void; reload: () => void } {
  const webview = document.createElement('webview') as Electron.WebviewTag
  // Why no allowpopups: the guest's preload intercepts a trusted click on a link before Chromium
  // considers a popup at all, so target="_blank" needs no popup path and every one stays denied.
  webview.setAttribute('partition', DOC_PREVIEW_PARTITION)
  webview.setAttribute('webpreferences', ORCA_BROWSER_GUEST_WEB_PREFERENCES_ATTRIBUTE)
  webview.setAttribute('aria-label', ariaLabel)
  // Browsers paint an undeclared page canvas white; the guest is transparent, so without this the
  // editor's dark surface shows through and default black text becomes unreadable.
  webview.style.backgroundColor = '#fff'
  webview.style.display = 'flex'
  webview.style.width = '100%'
  webview.style.height = '100%'
  webview.style.border = 'none'
  webview.addEventListener('did-start-loading', onLoadStarted)
  webview.addEventListener('did-stop-loading', onLoadStopped)
  webview.addEventListener('did-fail-load', onLoadFailed)
  // Both: a link to a sibling document is a full navigation, a fragment link is an in-page one,
  // and only the pair together tracks what Back can actually return to.
  webview.addEventListener('did-navigate', onNavigated)
  webview.addEventListener('did-navigate-in-page', onNavigated)
  // Why the document names its own tab: a preview is a browser tab, and this is how every other
  // one is named. What the document cannot do is name it the grant it is served over.
  webview.addEventListener('page-title-updated', onTitleUpdated)
  // Register before append so a guest attached mid-drag cannot swallow the pointer stream.
  registerPersistentWebview(previewId, webview)
  container.appendChild(webview)
  webview.setAttribute('src', url)

  return {
    webview,
    detach: () => {
      webview.removeEventListener('did-start-loading', onLoadStarted)
      webview.removeEventListener('did-stop-loading', onLoadStopped)
      webview.removeEventListener('did-fail-load', onLoadFailed)
      webview.removeEventListener('did-navigate', onNavigated)
      webview.removeEventListener('did-navigate-in-page', onNavigated)
      webview.removeEventListener('page-title-updated', onTitleUpdated)
      moveFocusToRendererBeforeWebviewDetach(webview)
      webview.remove()
      if (webviewRegistry.get(previewId) === webview) {
        unregisterPersistentWebview(previewId)
      }
    },
    // Why: the protocol handler answers with no-store, so a reload re-reads the workspace disk.
    reload: () => {
      try {
        webview.reload()
      } catch {
        webview.setAttribute('src', url)
      }
    }
  }
}
