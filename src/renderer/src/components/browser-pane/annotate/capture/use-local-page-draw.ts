import { useCallback, useMemo, type RefObject } from 'react'
import type { GrabModeState } from '../grab/useGrabMode'
import type { BrowserGuestAnnotationViewportBridge } from '../use-browser-guest-annotate-tools'
import type { MarkupModeController } from './useMarkupMode'

/**
 * Draw on a local page, which may start while Grab or Annotate is on: main clears the picker before capturing.
 * A capture still in flight is dropped once its document is replaced (reloads included) or its guest is lost.
 */
export function useLocalPageDraw({
  markup,
  grabState,
  stopPicker,
  viewportBridge,
  webviewRef
}: {
  markup: MarkupModeController
  grabState: GrabModeState
  /** Drops the renderer's pick, unsent card and toast. */
  stopPicker: () => void
  viewportBridge: BrowserGuestAnnotationViewportBridge
  webviewRef: RefObject<Electron.WebviewTag | null>
}): { startMarkup: () => Promise<void>; viewportBridge: BrowserGuestAnnotationViewportBridge } {
  const { start, abandonCapture } = markup
  const startMarkup = useCallback(() => {
    const webview = webviewRef.current
    const onGuestLost = (): void => abandonCapture()
    // Attached before the capture starts, so a crash or teardown delivered at any point after it can't slip past.
    webview?.addEventListener('destroyed', onGuestLost)
    webview?.addEventListener('render-process-gone', onGuestLost)
    // The pick is dropped only once the page is known capturable, so a Draw that can't start leaves it alone.
    return start(grabState === 'idle' ? undefined : stopPicker).finally(() => {
      webview?.removeEventListener('destroyed', onGuestLost)
      webview?.removeEventListener('render-process-gone', onGuestLost)
    })
  }, [abandonCapture, grabState, start, stopPicker, webviewRef])

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
