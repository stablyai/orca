import { useCallback, type MutableRefObject } from 'react'
import { deliverMarkupToClipboard } from './markup-clipboard-delivery'
import {
  useMarkupMode,
  type MarkupCaptureContext,
  type MarkupModeController
} from './useMarkupMode'

function readGuestId(webview: Electron.WebviewTag): number | null {
  try {
    return webview.isConnected ? webview.getWebContentsId() : null
  } catch {
    return null
  }
}

/** The settled guest a clean capture may start on: null while it is detached, unreadable, or loading a document. */
export function readCleanCaptureGuestId(webview: Electron.WebviewTag | null): number | null {
  try {
    return webview && !webview.isLoadingMainFrame() ? readGuestId(webview) : null
  } catch {
    return null
  }
}

export function useBrowserPageMarkupCapture(
  webviewRef: MutableRefObject<Electron.WebviewTag | null>,
  /** Set for local browser pages: main clears the picker before capturing, so Draw can start from Grab. */
  cleanPageId?: string
): MarkupModeController {
  return useMarkupMode({
    getCaptureContext: useCallback((): MarkupCaptureContext | null => {
      const webview = webviewRef.current
      if (!webview) {
        return null
      }
      const rect = webview.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        return null
      }
      const size = { cssWidth: rect.width, cssHeight: rect.height }
      const outputScale = window.devicePixelRatio || 1
      if (!cleanPageId) {
        return { source: { kind: 'webview', webview }, ...size, outputScale }
      }
      const guestId = readCleanCaptureGuestId(webview)
      if (guestId === null) {
        return null
      }
      return {
        source: { kind: 'clean-page', browserPageId: cleanPageId, guestId },
        ...size,
        outputScale,
        // The same element and guest the capture began on; a replaced or reattached guest is another page.
        isCurrent: () => webviewRef.current === webview && readGuestId(webview) === guestId
      }
    }, [cleanPageId, webviewRef]),
    onDeliver: deliverMarkupToClipboard
  })
}
