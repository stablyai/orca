// The item's details (description to "From") scroll under the pinned title, and the two share one cap
// so Activity keeps its room: half the pane, or all but 140px of it when that is more. Where the cap
// falls inside the details it is moved up to a boundary: between blocks, after a whole link row or a
// whole line of text, so a block's label never shows without at least one line of what it labels.
// Measured when the pane, the title or the details change size, never on scroll.
import { useCallback, useLayoutEffect, useState, type ReactNode, type UIEvent } from 'react'
import { cn } from '@/lib/class-names'
import { useScrollEdgeFades } from '@/lib/list-interaction/use-scroll-edge-fades'

/** The share of the pane the title and details may take, at least. */
const CAP_SHARE = 0.5
/** What Activity keeps below the details, when that leaves them more than `CAP_SHARE`. */
const ACTIVITY_KEEPS = 140

/** Marks where the details may be cut inside a block: after this whole row (`row`), or after any whole
 *  line of this text (`lines`; its line height must be in px). */
const BOT_ITEM_DETAILS_CUT = 'data-bot-item-cut'

/** The details' scroller: cut by the cap on a boundary, its cut edges faded so content out of view
 *  reads as more to scroll. Focus scrolled to keeps clear of the fades. */
export function BotItemDetailsScroller({ children }: { children: ReactNode }): React.JSX.Element {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const maxHeight = useBotItemDetailsCut(scroller)
  const fades = useScrollEdgeFades<HTMLDivElement>()
  const setFades = fades.ref
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      setScroller(node)
      setFades(node)
    },
    [setFades]
  )
  return (
    <div
      ref={ref}
      style={{ maxHeight }}
      className={cn(
        'scrollbar-sleek flex min-h-0 scroll-py-6 flex-col overflow-y-auto',
        fades.className
      )}
    >
      {children}
    </div>
  )
}

/** Activity scrolled under its heading fades at the top. Read from the scroll it already handles;
 *  `className` is the scroller's own. */
export function useBotItemActivityTopFade(
  onScroll: (event: UIEvent<HTMLDivElement>) => void,
  className: string
): {
  onScroll: (event: UIEvent<HTMLDivElement>) => void
  className: string
} {
  const [scrolled, setScrolled] = useState(false)
  return {
    onScroll: (event) => {
      onScroll(event)
      setScrolled(event.currentTarget.scrollTop > 1)
    },
    className: cn(className, scrolled && 'mask-t-from-[calc(100%-1.5rem)]')
  }
}

/** The details scroller's max height: `scroller` is the details' scroller, its parent the cap it shares
 *  with the title (the parent's first child), and that cap's parent the pane region they share with
 *  Activity. */
function useBotItemDetailsCut(scroller: HTMLElement | null): number | undefined {
  const [maxHeight, setMaxHeight] = useState<number>()
  useLayoutEffect(() => {
    const cap = scroller?.parentElement
    const region = cap?.parentElement
    const title = cap?.firstElementChild
    const column = scroller?.firstElementChild
    if (!scroller || !cap || !region || !(column instanceof HTMLElement)) {
      return
    }
    const measure = (): void => {
      const pane = region.clientHeight
      const aboveDetails = cap.offsetHeight - scroller.offsetHeight
      const room = Math.max(pane * CAP_SHARE, pane - ACTIVITY_KEEPS) - aboveDetails
      const next = botItemDetailsCut(column, room)
      setMaxHeight((current) => (current === next ? current : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(region)
    observer.observe(column)
    if (title && title !== scroller) {
      observer.observe(title)
    }
    return () => observer.disconnect()
  }, [scroller])
  return maxHeight
}

/** How much of `column` to show in `room`: all of it when it fits, else up to the last boundary that
 *  fits (the room itself when no boundary does). */
export function botItemDetailsCut(column: HTMLElement, room: number): number {
  const fits = Math.max(0, Math.floor(room))
  if (column.offsetHeight <= fits) {
    return fits
  }
  const top = column.getBoundingClientRect().top
  let cut = 0
  for (const block of column.children) {
    const box = block.getBoundingClientRect()
    if (box.bottom - top <= fits) {
      cut = box.bottom - top
      continue
    }
    if (box.top - top < fits) {
      cut = Math.max(cut, cutInside(block, top, fits))
    }
    break
  }
  return cut > 0 ? Math.floor(cut) : fits
}

function cutInside(block: Element, top: number, room: number): number {
  let cut = 0
  for (const mark of block.querySelectorAll<HTMLElement>(`[${BOT_ITEM_DETAILS_CUT}]`)) {
    const box = mark.getBoundingClientRect()
    if (mark.getAttribute(BOT_ITEM_DETAILS_CUT) === 'row') {
      if (box.bottom - top <= room) {
        cut = Math.max(cut, box.bottom - top)
      }
      continue
    }
    const line = Number.parseFloat(getComputedStyle(mark).lineHeight)
    if (!(line > 0)) {
      continue
    }
    const lines = Math.min(
      Math.floor((room - (box.top - top)) / line),
      Math.round(box.height / line)
    )
    if (lines >= 1) {
      cut = Math.max(cut, box.top - top + lines * line)
    }
  }
  return cut
}
