import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { BrowserGrabLabelAvoidArea } from '../../../../../../shared/browser/element-grab/browser-grab-types'

// Until the page is registered with main (a fresh page), the area is refused; try again for a few seconds.
const RETRY_MS = 300
const MAX_RETRIES = 10

/** The palette and hint's footprint relative to the page frame, in this window's pixels; null if unmeasurable. */
export function measureGrabLabelAvoidArea(
  frame: HTMLElement,
  covers: readonly (HTMLElement | null)[]
): BrowserGrabLabelAvoidArea | null {
  const frameRect = frame.getBoundingClientRect()
  if (frameRect.width <= 0 || frameRect.height <= 0) {
    return null
  }
  const rects = covers
    .filter((cover): cover is HTMLElement => cover !== null)
    .map((cover) => cover.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0)
  if (rects.length === 0) {
    return null
  }
  const left = Math.min(...rects.map((rect) => rect.left))
  const top = Math.min(...rects.map((rect) => rect.top))
  const right = Math.max(...rects.map((rect) => rect.right))
  const bottom = Math.max(...rects.map((rect) => rect.bottom))
  return {
    x: Math.round(left - frameRect.left),
    y: Math.round(top - frameRect.top),
    width: Math.round(right - left),
    height: Math.round(bottom - top),
    frameWidth: Math.round(frameRect.width),
    frameHeight: Math.round(frameRect.height)
  }
}

function sameArea(
  a: BrowserGrabLabelAvoidArea | null,
  b: BrowserGrabLabelAvoidArea | null
): boolean {
  if (a === null || b === null) {
    return a === b
  }
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.frameWidth === b.frameWidth &&
    a.frameHeight === b.frameHeight
  )
}

/**
 * Tells the page's picker where the palette and its hint sit, so the hover label is never placed under them.
 * Why measured and sent: the palette moves (drag, find bar), wraps and changes width; a fixed band can't cover that.
 */
export function useGrabLabelAvoidArea({
  pageId,
  frameRef,
  paletteRef,
  hintRef,
  enabled,
  layoutKey
}: {
  pageId: string
  /** The page's frame (its webview); the area is relative to it. */
  frameRef: RefObject<HTMLElement | null> | undefined
  paletteRef: RefObject<HTMLElement | null>
  hintRef: RefObject<HTMLElement | null>
  /** False while nothing is being picked (Draw), or mid-drag; the last area stays meanwhile. */
  enabled: boolean
  /** Changes whenever the palette's place or shape does (position, top, fit, hint shown). */
  layoutKey: string
}): void {
  // What main has accepted for which page. Only a successful send counts: before the page is registered main refuses
  // the area, and an unchanged palette would otherwise never send it again.
  const sentRef = useRef<BrowserGrabLabelAvoidArea | null>(null)
  const sentPageRef = useRef<string | null>(null)
  const reportedPageRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    const frame = frameRef?.current
    const palette = paletteRef.current
    if (!enabled || !frame || !palette) {
      return
    }
    let disposed = false
    let retryTimer: number | undefined
    let retries = 0
    let latest: BrowserGrabLabelAvoidArea | null = null
    const report = (): void => {
      window.clearTimeout(retryTimer)
      const area = measureGrabLabelAvoidArea(frame, [palette, hintRef.current])
      if (area === null || (sentPageRef.current === pageId && sameArea(area, sentRef.current))) {
        return
      }
      latest = area
      reportedPageRef.current = pageId
      void window.api.browser.setGrabLabelAvoidArea({ browserPageId: pageId, area }).then(
        (accepted) => {
          // A newer measurement, a closed palette or another page supersedes this reply.
          if (disposed || latest !== area) {
            return
          }
          if (accepted) {
            sentRef.current = area
            sentPageRef.current = pageId
            retries = 0
            return
          }
          if (retries < MAX_RETRIES) {
            retries += 1
            retryTimer = window.setTimeout(report, RETRY_MS)
          }
        },
        () => {}
      )
    }
    report()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report)
    observer?.observe(frame)
    observer?.observe(palette)
    return () => {
      disposed = true
      window.clearTimeout(retryTimer)
      observer?.disconnect()
    }
  }, [enabled, frameRef, hintRef, layoutKey, pageId, paletteRef])

  // The palette closed or moved to another page: the old page's picker no longer needs to step around it.
  useEffect(
    () => () => {
      if (reportedPageRef.current === pageId) {
        sentRef.current = null
        sentPageRef.current = null
        reportedPageRef.current = null
        void window.api.browser.setGrabLabelAvoidArea({ browserPageId: pageId, area: null })
      }
    },
    [pageId]
  )
}
