// A card kept inside a region narrower than the window (an item pane): the region is its collision
// boundary, and its width is capped to the region's, re-read whenever the region or the window changes
// size (a pane resized, zoom) while the card is open. Its height is the caller's: the placement's live
// available height (`--radix-hover-card-content-available-height`), which follows the link as it scrolls.
import { useLayoutEffect, useState, type RefObject } from 'react'
import { WINDOW_MARGIN } from './link-peek-side'

/** Where a card stays and how wide it may be there. */
export type PeekBounds = { boundary: Element; maxWidth: number }

/** Finds the region a card opened from `link` must stay inside; null leaves it to the window. */
export type PeekBoundary = (link: Element) => Element | null

export function usePeekBounds(
  open: boolean,
  link: RefObject<Element | null>,
  boundTo: PeekBoundary | undefined
): PeekBounds | null {
  const [bounds, setBounds] = useState<PeekBounds | null>(null)
  useLayoutEffect(() => {
    const anchor = link.current
    const boundary = open && anchor && boundTo ? boundTo(anchor) : null
    if (!anchor || !boundary) {
      setBounds((current) => (current === null ? current : null))
      return
    }
    const measure = (): void => {
      const maxWidth = Math.max(
        0,
        Math.floor(boundary.getBoundingClientRect().width - 2 * WINDOW_MARGIN)
      )
      setBounds((current) =>
        current?.boundary === boundary && current.maxWidth === maxWidth
          ? current
          : { boundary, maxWidth }
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(boundary)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [open, link, boundTo])
  return bounds
}
