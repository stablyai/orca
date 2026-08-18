import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { BrowserGrabPayload } from '../../../../../shared/browser-grab-types'
import type { BrowserOverlayViewport } from '../describe-page/browser-annotation-geometry'

// Why: the grab/annotation overlays anchor to the page viewport; a resize must
// re-measure so the pending-annotation card and tray stay glued to the element.
export function useBrowserPageOverlayViewportSync({
  isActive,
  pendingAnnotationPayload,
  browserAnnotationsLength,
  containerRef,
  setBrowserOverlayViewport
}: {
  isActive: boolean
  pendingAnnotationPayload: BrowserGrabPayload | null
  browserAnnotationsLength: number
  containerRef: MutableRefObject<HTMLDivElement | null>
  setBrowserOverlayViewport: Dispatch<SetStateAction<BrowserOverlayViewport>>
}): void {
  useEffect(() => {
    if (!isActive || (!pendingAnnotationPayload && browserAnnotationsLength === 0)) {
      return
    }

    const observedContainer = containerRef.current
    const resizeObserver =
      typeof ResizeObserver === 'undefined' || !observedContainer
        ? null
        : new ResizeObserver(() => {
            setBrowserOverlayViewport((current) => ({ ...current, version: current.version + 1 }))
          })
    if (resizeObserver && observedContainer) {
      resizeObserver.observe(observedContainer)
    }

    return () => {
      resizeObserver?.disconnect()
    }
  }, [
    browserAnnotationsLength,
    containerRef,
    isActive,
    pendingAnnotationPayload,
    setBrowserOverlayViewport
  ])
}
