import { useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

// Why: below this count plain rows keep the DOM identical to the
// pre-virtualization markup (natural flow, no absolute positioning), so small
// changesets keep exact scrollbar and flicker-free behavior. `STA-351` /
// `STA-1280` jank only appears with hundreds of rows.
export const SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS = 50
// Why: rows are one py-1 text-xs line, except conflict/submodule rows which
// add a second label line — so estimate the common height and let
// measureElement correct the tall variants. Identical entries measure
// identically, so a git-status refresh cannot move the scroll position.
export const SOURCE_CONTROL_FILE_ROW_HEIGHT_PX = 24
export const SOURCE_CONTROL_FILE_ROW_OVERSCAN = 10

/**
 * Offset of `container` from the start of `scrollElement`'s scrollable content.
 * Independent of current scrollTop (relative tops + scrollTop cancel out).
 */
export function measureSourceControlScrollMargin(
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
export function observeSourceControlScrollMargin(
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
    // Why: child-list churn can detach previously observed sections; pruning
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

  // Why: sections mount/unmount as direct scroller children; re-observe so a
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
 * Windows one source-control section's rows inside the panel's shared
 * scroller. Sections below SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS render plainly;
 * larger ones mount only viewport + overscan rows.
 */
export function SourceControlVirtualFileList<TRow>({
  rows,
  getRowKey,
  renderRow,
  scrollElement
}: {
  rows: readonly TRow[]
  getRowKey: (row: TRow) => string
  renderRow: (row: TRow) => React.ReactNode
  // Why: a state-held element, not a ref — ancestor host refs are not attached
  // yet when this component's mount effects run, so a ref would leave the
  // virtualizer unobserved until some unrelated re-render.
  scrollElement: HTMLDivElement | null
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  const virtualize = rows.length >= SOURCE_CONTROL_VIRTUALIZE_MIN_ROWS

  // Why: the section shares the panel scroller with the commit area and
  // sibling sections, so the virtualizer needs this list's offset inside that
  // scroller. Measure on mount / scrollElement attach and when observers
  // report layout shifts — never during ordinary React renders (git-status
  // polls re-render often and must not force synchronous layout).
  useLayoutEffect(() => {
    if (!virtualize) {
      return
    }
    const container = containerRef.current
    if (!container || !scrollElement) {
      return
    }

    const updateMargin = (): void => {
      const nextMargin = measureSourceControlScrollMargin(container, scrollElement)
      setScrollMargin((current) => (current === nextMargin ? current : nextMargin))
    }

    updateMargin()
    return observeSourceControlScrollMargin(container, scrollElement, updateMargin)
  }, [scrollElement, virtualize])

  const virtualizer = useVirtualizer({
    count: rows.length,
    enabled: virtualize && scrollElement !== null,
    getScrollElement: () => scrollElement,
    estimateSize: () => SOURCE_CONTROL_FILE_ROW_HEIGHT_PX,
    overscan: SOURCE_CONTROL_FILE_ROW_OVERSCAN,
    scrollMargin,
    // Why: stable row keys let the virtualizer carry item identity across
    // status refreshes instead of remounting the window each poll.
    getItemKey: (index) => {
      const row = rows[index]
      return row === undefined ? index : getRowKey(row)
    }
  })

  if (!virtualize) {
    return <>{rows.map((row) => renderRow(row))}</>
  }

  return (
    <div
      ref={containerRef}
      data-testid="source-control-virtual-list"
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
