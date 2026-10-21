import { useEffect, type RefObject } from 'react'
import {
  getBrowserPageViewportScrollState,
  type BrowserPageViewportScrollState
} from './browser-page-viewport'

export function useBrowserPageViewportScrollReporting(
  browserPageId: string,
  scroller: HTMLDivElement | null,
  viewportPresetId: string | null,
  scrollerRef?: RefObject<HTMLDivElement | null>
): void {
  useEffect(() => {
    const activeScroller = scrollerRef?.current ?? scroller
    let reportFrame: number | null = null
    const send = (): void => {
      reportFrame = null
      const state: BrowserPageViewportScrollState | null = scrollerRef
        ? getBrowserPageViewportScrollState(browserPageId, activeScroller ?? undefined)
        : getBrowserPageViewportScrollState(browserPageId)
      if (state) {
        window.api.browser.reportViewportScrollState?.({ browserPageId, state })
      }
    }
    const report = (): void => {
      if (typeof requestAnimationFrame === 'undefined') {
        send()
        return
      }
      if (reportFrame === null) {
        reportFrame = requestAnimationFrame(send)
      }
    }
    report()
    if (!activeScroller) {
      return () => {
        if (reportFrame !== null && typeof cancelAnimationFrame !== 'undefined') {
          cancelAnimationFrame(reportFrame)
        }
      }
    }
    activeScroller.addEventListener('scroll', report, { passive: true })
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report)
    resizeObserver?.observe(activeScroller)
    return () => {
      activeScroller.removeEventListener('scroll', report)
      resizeObserver?.disconnect()
      if (reportFrame !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(reportFrame)
      }
    }
  }, [browserPageId, scroller, viewportPresetId, scrollerRef])
}
