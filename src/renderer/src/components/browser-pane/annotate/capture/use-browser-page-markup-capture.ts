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
      return {
        source: cleanPageId
          ? { kind: 'clean-page', browserPageId: cleanPageId }
          : { kind: 'webview', webview },
        cssWidth: rect.width,
        cssHeight: rect.height,
        outputScale: window.devicePixelRatio || 1,
        // The same element and guest the capture began on; a replaced or reattached guest is another page.
        ...(cleanPageId
          ? {
              isCurrent: (
                (guestId) => () =>
                  webviewRef.current === webview && readGuestId(webview) === guestId
              )(readGuestId(webview))
            }
          : {})
      }
    }, [cleanPageId, webviewRef]),
    onDeliver: deliverMarkupToClipboard
  })
}
