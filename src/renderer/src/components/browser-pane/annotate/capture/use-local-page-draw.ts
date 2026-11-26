import { useCallback, useEffect, useMemo, type RefObject } from 'react'
import type { GrabModeState } from '../grab/useGrabMode'
import type { BrowserGuestAnnotationViewportBridge } from '../use-browser-guest-annotate-tools'
import type { MarkupModeController } from './useMarkupMode'

/**
 * Draw on a local page, which may start while Grab or Annotate is on: main clears the picker before capturing.
 * A capture still in flight is dropped once its document is replaced (reloads included), its guest is lost, or its
 * pane is hidden.
 */
export function useLocalPageDraw({
  markup,
  grabState,
  stopPicker,
  isActive,
  viewportBridge,
  webviewRef
}: {
  markup: MarkupModeController
  grabState: GrabModeState
  /** Drops the renderer's pick, unsent card and toast. */
  stopPicker: () => void
  isActive: boolean
  viewportBridge: BrowserGuestAnnotationViewportBridge
  webviewRef: RefObject<Electron.WebviewTag | null>
}): { startMarkup: () => Promise<void>; viewportBridge: BrowserGuestAnnotationViewportBridge } {
  const { start, abandonCapture } = markup
  const startMarkup = useCallback(() => {
    if (grabState !== 'idle') {
      stopPicker()
    }
    return start()
  }, [grabState, start, stopPicker])

  useEffect(() => {
    if (!isActive) {
      abandonCapture()
    }
  }, [abandonCapture, isActive])

  const capturing = markup.state === 'capturing'
  useEffect(() => {
    const webview = webviewRef.current
    if (!capturing || !webview) {
      return
    }
    webview.addEventListener('destroyed', abandonCapture)
    webview.addEventListener('render-process-gone', abandonCapture)
    return () => {
      webview.removeEventListener('destroyed', abandonCapture)
      webview.removeEventListener('render-process-gone', abandonCapture)
    }
  }, [abandonCapture, capturing, webviewRef])

  const drawAwareBridge = useMemo<BrowserGuestAnnotationViewportBridge>(
    () => ({
      ...viewportBridge,
      invalidateDocument: () => {
        abandonCapture()
        viewportBridge.invalidateDocument()
      }
    }),
    [abandonCapture, viewportBridge]
  )
  return { startMarkup, viewportBridge: drawAwareBridge }
}
