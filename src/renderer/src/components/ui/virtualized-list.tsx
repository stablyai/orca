import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual'

// Small lists stay in natural flow; windowing pays off only at larger sizes.
export const VIRTUALIZED_LIST_MIN_ROWS = 50
export const VIRTUALIZED_LIST_ROW_HEIGHT_PX = 24
export const VIRTUALIZED_LIST_OVERSCAN = 10

/** Relative tops plus scrollTop yield the container’s content offset, independent of scrolling. */
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

/** Observe layout shifts that move the list: its own size, and the children of every element between it
 *  and the scroller (a section above it folding moves it without resizing the scroller). Subtree mutations
 *  below the list are excluded because windowed row churn cannot move the list's origin. */
export function observeVirtualizedListScrollMargin(
  container: HTMLElement,
  scrollElement: HTMLElement,
  onLayout: () => void
): () => void {
  const resizeObserver = new ResizeObserver(onLayout)
  resizeObserver.observe(container)
  resizeObserver.observe(scrollElement)
  // The scroller and the list's ancestors below it: a `display: contents` wrapper has no box, so its
  // children are watched rather than it.
  const parents: HTMLElement[] = [scrollElement]
  for (
    let node = container.parentElement;
    node && node !== scrollElement && scrollElement.contains(node);
    node = node.parentElement
  ) {
    parents.push(node)
  }
  let observedChildren = new Set<Element>()

  const observeParentChildren = (): void => {
    const currentChildren = new Set(parents.flatMap((parent) => [...parent.children]))
    // Prune detached sibling targets so long-lived lists do not retain stale DOM.
    for (const child of observedChildren) {
      if (!currentChildren.has(child) && child !== container) {
        resizeObserver.unobserve(child)
      }
    }
    for (const child of currentChildren) {
      if (!observedChildren.has(child)) {
        resizeObserver.observe(child)
      }
    }
    observedChildren = currentChildren
  }
  observeParentChildren()

  // Re-observe when siblings at any of those levels come or go, so later resizes update this list's offset.
  const mutationObserver = new MutationObserver(() => {
    observeParentChildren()
    onLayout()
  })
  for (const parent of parents) {
    mutationObserver.observe(parent, { childList: true })
  }

  return () => {
    resizeObserver.disconnect()
    mutationObserver.disconnect()
  }
}

export function VirtualizedList<TRow>({
  rows,
  getRowKey,
  renderRow,
  scrollElement,
  estimateRowHeightPx = VIRTUALIZED_LIST_ROW_HEIGHT_PX,
  activeRowKey,
  keptRowKey,
  minimumRows = VIRTUALIZED_LIST_MIN_ROWS,
  announceListPosition = false,
  hasUnloadedRows
}: {
  rows: readonly TRow[]
  getRowKey: (row: TRow) => string
  renderRow: (row: TRow) => React.ReactNode
  // State tracks scroller attachment; ancestor refs arrive after mount effects and alone would leave the virtualizer unobserved.
  scrollElement: HTMLDivElement | null
  // Callers supply different row padding; wrong initial estimates jump the scrollbar before measurement corrects them.
  estimateRowHeightPx?: number
  // Why: keyboard-driven lists must mount and reveal selections outside the current window.
  activeRowKey?: string
  // Mounted wherever it scrolls, without scrolling to it: a row holding keyboard focus keeps it.
  keptRowKey?: string
  minimumRows?: number
  // Expose list semantics only by opt-in on the windowed path; small fragments have no role container, and other surfaces own their a11y roles.
  announceListPosition?: boolean
  // Paged callers cannot announce loaded count as total; ARIA represents unknown totals as -1.
  hasUnloadedRows?: boolean
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const virtualize = rows.length >= minimumRows
  const activeIndex =
    activeRowKey === undefined ? -1 : rows.findIndex((row) => getRowKey(row) === activeRowKey)
  const keptIndex =
    keptRowKey === undefined ? -1 : rows.findIndex((row) => getRowKey(row) === keptRowKey)
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indexes = defaultRangeExtractor(range)
      for (const pinned of [activeIndex, keptIndex]) {
        if (pinned >= 0 && !indexes.includes(pinned)) {
          indexes.push(pinned)
        }
      }
      return indexes.sort((a, b) => a - b)
    },
    [activeIndex, keptIndex]
  )

  // Shared scrollers need this list’s offset; measure on attachment/layout shifts, never ordinary renders.
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

  // Stable while the rows are: the virtualizer recomputes every row's position when the key callback
  // changes, and its own scroll-driven renders pass the same rows.
  const getItemKey = useCallback(
    (index: number) => {
      const row = rows[index]
      return row === undefined ? index : getRowKey(row)
    },
    [rows, getRowKey]
  )
  const virtualizer = useVirtualizer({
    count: rows.length,
    // Why the null half: disabled nulls scrollOffset, so initialOffset() cannot latch 0 pre-attach.
    enabled: virtualize && scrollElement !== null,
    getScrollElement: () => scrollElement,
    estimateSize: () => estimateRowHeightPx,
    overscan: VIRTUALIZED_LIST_OVERSCAN,
    rangeExtractor,
    scrollMargin,
    // Threshold crossing first attaches the virtualizer; preserve current scroll position instead of its initial zero.
    initialOffset: () => scrollElement?.scrollTop ?? 0,
    // Stable keys preserve item identity across status polls instead of remounting rows.
    getItemKey
  })

  // Measured sizes are kept by key; drop departed rows' once they outnumber the rows, so a long-lived list
  // whose rows come and go holds sizes for at most about twice its current rows.
  useLayoutEffect(() => {
    const sizes = virtualizer.itemSizeCache
    if (sizes.size <= rows.length) {
      return
    }
    const live = new Set<unknown>(rows.map(getRowKey))
    for (const key of sizes.keys()) {
      if (!live.has(key)) {
        sizes.delete(key)
      }
    }
  }, [rows, getRowKey, virtualizer])

  useLayoutEffect(() => {
    if (virtualize && scrollElement && activeIndex >= 0) {
      virtualizer.scrollToIndex(activeIndex, { align: 'auto' })
    }
  }, [activeIndex, activeRowKey, scrollElement, virtualize, virtualizer])

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
            // Item positions include scroller-wide scrollMargin; subtract it for container-relative placement.
            style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
          >
            {renderRow(row)}
          </div>
        )
      })}
    </div>
  )
}
