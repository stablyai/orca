// A card kept inside a region narrower than the window (an item pane): the region is its collision
// boundary, and its width and height are capped to the region's room, re-read whenever the region
// or the window changes size (a pane resized, zoom) while the card is open. Nothing is read on scroll.
import { useLayoutEffect, useState, type RefObject } from 'react'
import { CARD_OFFSET, WINDOW_MARGIN } from './link-peek-side'

/** Where a card stays and how big it may be there: `maxHeight` is the room on the larger side of the
 *  link, which is the side the card flips to when it doesn't fit the other. */
export type PeekBounds = { boundary: Element; maxWidth: number; maxHeight: number }

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
      const region = boundary.getBoundingClientRect()
      const at = anchor.getBoundingClientRect()
      const room = Math.max(region.bottom - at.bottom, at.top - region.top)
      const maxWidth = Math.max(0, Math.floor(region.width - 2 * WINDOW_MARGIN))
      const maxHeight = Math.max(0, Math.floor(room - CARD_OFFSET - WINDOW_MARGIN))
      setBounds((current) =>
        current?.boundary === boundary &&
        current.maxWidth === maxWidth &&
        current.maxHeight === maxHeight
          ? current
          : { boundary, maxWidth, maxHeight }
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
