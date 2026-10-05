import { useCallback, type MutableRefObject } from 'react'
import type { BrowserPageSurface } from '../host-guest/browser-page-surface'
import { deliverMarkupToClipboard } from './markup-clipboard-delivery'
import {
  useMarkupMode,
  type MarkupCaptureContext,
  type MarkupModeController
} from './useMarkupMode'

export function useBrowserPageMarkupCapture(
  webviewRef: MutableRefObject<Electron.WebviewTag | null>,
  surface?: BrowserPageSurface
): MarkupModeController {
  return useMarkupMode({
    getCaptureContext: useCallback((): MarkupCaptureContext | null => {
      const webview = webviewRef.current
      const rect = surface ? surface.getBounds() : webview?.getBoundingClientRect()
      if (!rect) {
        return null
      }
      if (rect.width <= 0 || rect.height <= 0) {
        return null
      }
      return {
        source: surface
          ? { kind: 'surface', capture: surface.captureViewport }
          : { kind: 'webview', webview: webview! },
        cssWidth: rect.width,
        cssHeight: rect.height,
        outputScale: window.devicePixelRatio || 1
      }
    }, [surface, webviewRef]),
    onDeliver: deliverMarkupToClipboard
  })
}
