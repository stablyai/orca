import { useEffect } from 'react'
import {
  getBrowserPageViewportScrollState,
  type BrowserPageViewportScrollState
} from './browser-page-viewport'

export function useBrowserPageViewportScrollReporting(
  browserPageId: string,
  scroller: HTMLDivElement | null,
  viewportPresetId: string | null
): void {
  useEffect(() => {
    let reportFrame: number | null = null
    const send = (): void => {
      reportFrame = null
      const state: BrowserPageViewportScrollState | null =
        getBrowserPageViewportScrollState(browserPageId)
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
    if (!scroller) {
      return () => {
        if (reportFrame !== null && typeof cancelAnimationFrame !== 'undefined') {
          cancelAnimationFrame(reportFrame)
        }
      }
    }
    scroller.addEventListener('scroll', report, { passive: true })
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report)
    resizeObserver?.observe(scroller)
    return () => {
      scroller.removeEventListener('scroll', report)
      resizeObserver?.disconnect()
      if (reportFrame !== null && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(reportFrame)
      }
    }
  }, [browserPageId, scroller, viewportPresetId])
}
