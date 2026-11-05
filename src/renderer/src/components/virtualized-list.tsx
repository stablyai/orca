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

/** Observe list/sibling layout shifts, excluding subtree mutations because windowed row churn cannot move the list’s origin. */
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
    // Prune detached sibling targets so long-lived lists do not retain stale DOM.
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

  // Re-observe direct scroller children when siblings change so later resizes update this list’s offset.
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

export function VirtualizedList<TRow>({
  rows,
  getRowKey,
  renderRow,
  scrollElement,
  estimateRowHeightPx = VIRTUALIZED_LIST_ROW_HEIGHT_PX,
  activeRowKey,
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
  const rangeExtractor = useCallback(
    (range: Parameters<typeof defaultRangeExtractor>[0]) => {
      const indexes = defaultRangeExtractor(range)
      if (activeIndex >= 0 && !indexes.includes(activeIndex)) {
        indexes.push(activeIndex)
        indexes.sort((a, b) => a - b)
      }
      return indexes
    },
    [activeIndex]
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
    getItemKey: (index) => {
      const row = rows[index]
      return row === undefined ? index : getRowKey(row)
    }
  })

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
