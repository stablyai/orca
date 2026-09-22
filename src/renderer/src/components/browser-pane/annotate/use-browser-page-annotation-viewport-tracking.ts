import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { BrowserOverlayViewport } from '../describe-page/browser-annotation-geometry'
import { subscribeBrowserPageViewportScroll } from '../host-guest/browser-page-viewport'

export function useBrowserPageAnnotationViewportTracking({
  isActive,
  pendingAnnotation,
  annotationCount,
  container,
  scroller,
  setBrowserOverlayViewport
}: {
  isActive: boolean
  pendingAnnotation: unknown
  annotationCount: number
  container: HTMLDivElement | null
  scroller: HTMLDivElement | null
  setBrowserOverlayViewport: Dispatch<SetStateAction<BrowserOverlayViewport>>
}): void {
  useEffect(() => {
    if (!isActive || (!pendingAnnotation && annotationCount === 0)) {
      return
    }
    let frame: number | null = null
    const bump = (): void => {
      if (frame !== null) {
        return
      }
      frame = window.requestAnimationFrame(() => {
        frame = null
        setBrowserOverlayViewport((current) => ({ ...current, version: current.version + 1 }))
      })
    }
    const observer =
      typeof ResizeObserver === 'undefined' || !container ? null : new ResizeObserver(bump)
    if (observer && container) {
      observer.observe(container)
    }
    const unsubscribe = subscribeBrowserPageViewportScroll(scroller, bump)
    return () => {
      observer?.disconnect()
      unsubscribe()
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
      }
    }
  }, [annotationCount, container, isActive, pendingAnnotation, scroller, setBrowserOverlayViewport])
}
