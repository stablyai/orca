import { clearLiveBrowserUrl } from '../describe-page/live-browser-url-registry'
import {
  clearBrowserPageViewportPresetSize,
  removeBrowserPageViewport
} from './browser-page-viewport'
import {
  moveFocusToRendererBeforeWebviewDetach,
  registeredWebContentsIds,
  unregisterPersistentWebview,
  webviewRegistry
} from './webview-registry'

function removePersistentWebview(
  browserTabId: string,
  { preserveViewport, replacement }: { preserveViewport: boolean; replacement: boolean }
): Promise<void> {
  const webview = webviewRegistry.get(browserTabId)
  if (!webview) {
    // A viewport can outlive its registry entry; explicit close must remove the parked shell too.
    if (!preserveViewport) {
      clearBrowserPageViewportPresetSize(browserTabId)
      removeBrowserPageViewport(browserTabId)
    }
    registeredWebContentsIds.delete(browserTabId)
    clearLiveBrowserUrl(browserTabId)
    if (!replacement) {
      return window.api.browser.unregisterGuest({ browserPageId: browserTabId }).catch(() => {})
    }
    return Promise.resolve()
  }
  let webContentsId = registeredWebContentsIds.get(browserTabId)
  try {
    webContentsId = webview.getWebContentsId()
  } catch {
    // A not-yet-attached element has no native identity to unregister.
  }
  const unregisterGuest = Promise.resolve(
    !replacement || webContentsId !== undefined
      ? window.api.browser.unregisterGuest({
          browserPageId: browserTabId,
          webContentsId,
          replacement
        })
      : undefined
  ).catch(() => {})
  moveFocusToRendererBeforeWebviewDetach(webview)
  webview.remove()
  if (webviewRegistry.get(browserTabId) === webview) {
    if (!preserveViewport) {
      clearBrowserPageViewportPresetSize(browserTabId)
      removeBrowserPageViewport(browserTabId)
    }
    registeredWebContentsIds.delete(browserTabId)
    clearLiveBrowserUrl(browserTabId)
    unregisterPersistentWebview(browserTabId)
  }
  return unregisterGuest
}

export function closePersistentBrowserPage(browserTabId: string): Promise<void> {
  return removePersistentWebview(browserTabId, { preserveViewport: false, replacement: false })
}

export function replacePersistentWebview(
  browserTabId: string,
  { preserveViewport = false }: { preserveViewport?: boolean } = {}
): Promise<void> {
  return removePersistentWebview(browserTabId, { preserveViewport, replacement: true })
}
