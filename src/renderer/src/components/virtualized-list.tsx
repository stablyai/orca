import { useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

// Small lists stay in natural flow; windowing pays off only at larger sizes.
export const VIRTUALIZED_LIST_MIN_ROWS = 50
export const VIRTUALIZED_LIST_ROW_HEIGHT_PX = 24
export const VIRTUALIZED_LIST_OVERSCAN = 10

/**
 * Offset of `container` from the start of `scrollElement`'s scrollable content.
 * Independent of current scrollTop (relative tops + scrollTop cancel out).
 */
export function measureVirtualizedListScrollMargin(
  container: HTMLElement,
  scrollElement: HTMLElement
): number {
  return Math.round(
    container.getBoundingClientRect().top -
      scrollElement.getBoundingClientRect().top +
      scrollElement.scrollTop
  )
}

/**
 * Re-measure when the list or anything that can shift its offset inside the
 * shared scroller changes size or structure (commit area, headers, siblings).
 * Does not observe subtree mutations — virtualized row mount/unmount would
 * thrash and never change scroll margin.
 */
export function observeVirtualizedListScrollMargin(
  container: HTMLElement,
  scrollElement: HTMLElement,
  onLayout: () => void
): () => void {
  const resizeObserver = new ResizeObserver(onLayout)
  resizeObserver.observe(container)
  resizeObserver.observe(scrollElement)
  let observedChildren = new Set<Element>()

  const observeScrollerChildren = (): void => {
    const currentChildren = new Set(scrollElement.children)
    // Why: child-list churn can detach previously observed siblings; pruning
    // targets prevents the long-lived virtual list from retaining stale DOM.
    for (const child of observedChildren) {
      if (!currentChildren.has(child) && child !== container) {
        resizeObserver.unobserve(child)
      }
    }
    for (const child of currentChildren) {
      resizeObserver.observe(child)
    }
    observedChildren = currentChildren
  }
  observeScrollerChildren()

  // Why: list siblings mount/unmount as direct scroller children; re-observe so a
  // newly inserted sibling can still shift this list's margin when it resizes.
  const mutationObserver = new MutationObserver(() => {
    observeScrollerChildren()
    onLayout()
  })
  mutationObserver.observe(scrollElement, { childList: true })

  return () => {
    resizeObserver.disconnect()
    mutationObserver.disconnect()
  }
}

/**
 * Renders rows in natural flow until the list is large enough to benefit from
 * windowing, then mounts only the viewport plus overscan rows.
 */
export function VirtualizedList<TRow>({
  rows,
  getRowKey,
  renderRow,
  scrollElement,
  estimateRowHeightPx = VIRTUALIZED_LIST_ROW_HEIGHT_PX,
  announceListPosition = false,
  hasUnloadedRows
}: {
  rows: readonly TRow[]
  getRowKey: (row: TRow) => string
  renderRow: (row: TRow) => React.ReactNode
  // Why: a state-held element, not a ref — ancestor host refs are not attached
  // yet when this component's mount effects run, so a ref would leave the
  // virtualizer unobserved until some unrelated re-render.
  scrollElement: HTMLDivElement | null
  // Why: callers outside source control have their own row paddings; measureElement
  // still corrects, but a wrong estimate makes the initial scrollbar jump.
  estimateRowHeightPx?: number
  // Why: windowing hides the real row count and each row's place in it from assistive tech, so
  // opt in to say both. Virtualized path only — below the threshold this returns a bare fragment,
  // with no container to carry the roles, so small lists announce no list at all. Off by default:
  // turning it on rewrites every other caller's a11y tree, and list/tree/grid is each surface's call.
  announceListPosition?: boolean
  // Why: a caller that pages in rows holds fewer than exist, and announcing the loaded count as the
  // total is the mis-statement aria-setsize exists to prevent — ARIA spells that unknown total -1.
  hasUnloadedRows?: boolean
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const virtualize = rows.length >= VIRTUALIZED_LIST_MIN_ROWS

  // Why: the list shares its scroller with headers and sibling lists, so the
  // virtualizer needs this list's offset inside that scroller. Measure on mount
  // / scrollElement attach and when observers report layout shifts — never during
  // ordinary React renders.
  useLayoutEffect(() => {
    if (!virtualize) {
      return
    }
    const container = containerRef.current
    if (!container || !scrollElement) {
      return
    }

    const updateMargin = (): void => {
      const nextMargin = measureVirtualizedListScrollMargin(container, scrollElement)
      setScrollMargin((current) => (current === nextMargin ? current : nextMargin))
    }

    updateMargin()
    return observeVirtualizedListScrollMargin(container, scrollElement, updateMargin)
  }, [scrollElement, virtualize])

  const virtualizer = useVirtualizer({
    count: rows.length,
    // Why the null half: disabled nulls scrollOffset, so initialOffset() cannot latch 0 pre-attach.
    enabled: virtualize && scrollElement !== null,
    getScrollElement: () => scrollElement,
    estimateSize: () => estimateRowHeightPx,
    overscan: VIRTUALIZED_LIST_OVERSCAN,
    scrollMargin,
    // Why: crossing the threshold attaches the scroller for the first time and the virtualizer
    // writes its start offset back — from 0, scrolling the shared scroller to the top under the
    // user, unless told where they already are.
    initialOffset: () => scrollElement?.scrollTop ?? 0,
    // Why: stable row keys let the virtualizer carry item identity across
    // status refreshes instead of remounting the window each poll.
    getItemKey: (index) => {
      const row = rows[index]
      return row === undefined ? index : getRowKey(row)
    }
  })

  // Why not the window's count: the window is what AT must not be able to hear.
  const announcedSetSize = hasUnloadedRows ? -1 : rows.length

  if (!virtualize) {
    return <>{rows.map((row) => renderRow(row))}</>
  }

  return (
    <div
      ref={containerRef}
      data-testid="virtualized-list"
      role={announceListPosition ? 'list' : undefined}
      className="relative w-full"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index]
        if (row === undefined) {
          return null
        }
        return (
          <div
            key={item.key}
            ref={virtualizer.measureElement}
            data-index={item.index}
            role={announceListPosition ? 'listitem' : undefined}
            aria-setsize={announceListPosition ? announcedSetSize : undefined}
            aria-posinset={announceListPosition ? item.index + 1 : undefined}
            className="absolute top-0 left-0 w-full"
            // Why: item.start includes scrollMargin (offsets are scroller-wide),
            // but rows position inside this container, so subtract it back out.
            style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
          >
            {renderRow(row)}
          </div>
        )
      })}
    </div>
  )
}
