import { useCallback, useEffect, useMemo } from 'react'
import type { GrabModeState } from '../grab/useGrabMode'
import type { BrowserGuestAnnotationViewportBridge } from '../use-browser-guest-annotate-tools'
import type { MarkupModeController } from './useMarkupMode'

/**
 * Draw on a local page, which may start while Grab or Annotate is on: main clears the picker before capturing.
 * A capture still in flight is dropped once its document is replaced (reloads included) or its pane is hidden.
 */
export function useLocalPageDraw({
  markup,
  grabState,
  stopPicker,
  isActive,
  viewportBridge
}: {
  markup: MarkupModeController
  grabState: GrabModeState
  /** Drops the renderer's pick, unsent card and toast. */
  stopPicker: () => void
  isActive: boolean
  viewportBridge: BrowserGuestAnnotationViewportBridge
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
