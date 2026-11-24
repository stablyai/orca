// The item's details (description to "From") scroll under the pinned title, and the two share one cap
// so Activity keeps its room: half the pane, or all but 140px of it when that is more. Where the cap
// falls inside the details it moves to a legal cut (bot-item-details-cut.ts): between blocks, after a
// whole link row or a whole line of text, so a block's label never shows without its first line.
import { useCallback, useLayoutEffect, useState, type ReactNode, type UIEvent } from 'react'
import { cn } from '@/lib/class-names'
import { useScrollEdgeFades } from '@/lib/list-interaction/use-scroll-edge-fades'
import { pickBotItemDetailsCut, readBotItemDetailsGeometry } from './bot-item-details-cut'

/** The share of the pane the title and details may take, at least. */
const CAP_SHARE = 0.5
/** What Activity keeps below the details, when that leaves them more than `CAP_SHARE`. */
const ACTIVITY_KEEPS = 140

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
 *  Activity. Measured again when the region, the title, any block or the details' content changes
 *  (an edit can move a line between blocks without changing any size), never on scroll. */
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
      const next = pickBotItemDetailsCut(readBotItemDetailsGeometry(column), room)
      setMaxHeight((current) => (current === next ? current : next))
    }
    measure()
    return observeBotItemDetails(column, [region, title !== scroller ? title : null], measure)
  }, [scroller])
  return maxHeight
}

/** Calls `changed` when `column`, one of its blocks, one of `around`, or the column's content changes;
 *  returns the cleanup that ends every observer. */
function observeBotItemDetails(
  column: HTMLElement,
  around: readonly (Element | null | undefined)[],
  changed: () => void
): () => void {
  const sizes = new ResizeObserver(changed)
  const observeSizes = (): void => {
    sizes.disconnect()
    for (const element of [...around, column, ...column.children]) {
      if (element) {
        sizes.observe(element)
      }
    }
  }
  const content = new MutationObserver(() => {
    observeSizes()
    changed()
  })
  observeSizes()
  content.observe(column, { childList: true, subtree: true, characterData: true })
  return () => {
    sizes.disconnect()
    content.disconnect()
  }
}
