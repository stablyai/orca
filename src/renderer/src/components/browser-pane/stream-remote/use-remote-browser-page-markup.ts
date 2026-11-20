import { useCallback, type RefObject } from 'react'
import {
  useMarkupMode,
  type MarkupCaptureContext,
  type MarkupModeController
} from '../annotate/capture/useMarkupMode'
import { deliverMarkupToClipboard } from '../annotate/capture/markup-clipboard-delivery'

/** Markup snapshots the displayed screencast <img> (no injection), so it works on remote panes even though element-grab doesn't. */
export function useRemoteBrowserPageMarkup(
  imageRef: RefObject<HTMLImageElement | null>,
  remoteViewportRef: RefObject<HTMLDivElement | null>
): MarkupModeController {
  return useMarkupMode({
    getCaptureContext: useCallback((): MarkupCaptureContext | null => {
      const element = imageRef.current
      if (!element || !remoteViewportRef.current) {
        return null
      }
      // Why the image's box: the frame is letterboxed, and the pane's shape would distort it.
      const rect = element.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        return null
      }
      return {
        source: { kind: 'image', element },
        cssWidth: rect.width,
        cssHeight: rect.height,
        outputScale: window.devicePixelRatio || 1
      }
    }, [imageRef, remoteViewportRef]),
    onDeliver: deliverMarkupToClipboard
  })
}
