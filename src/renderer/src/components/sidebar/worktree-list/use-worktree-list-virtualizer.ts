import { useCallback, useMemo, useRef } from 'react'
import type React from 'react'
import {
  measureElement as measureVirtualElementSize,
  useVirtualizer
} from '@tanstack/react-virtual'
import type { Range } from '@tanstack/react-virtual'
import {
  estimateRenderRowSize,
  extractWorktreeVirtualRowIndexes,
  getRenderRowKey,
  getStickyHeaderIndexes,
  WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP,
  type RenderRow
} from '../worktree-list-virtual-rows'
import { WORKTREE_SIDEBAR_REVEAL_TOP_INSET } from '../worktree-sidebar-reveal'
import { getVirtualRowIndex } from './virtual-row-dom-attributes'
import {
  shouldAdjustWorktreeSidebarMeasuredRowScroll,
  USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS
} from './worktree-sidebar-scroll-tuning'

export type WorktreeListVirtualizer = ReturnType<typeof useWorktreeListVirtualizer>

// The TanStack virtualizer plus the row-identity guards that stop a recycled DOM node
// from writing a stale height into the wrong slot.
export function useWorktreeListVirtualizer(args: {
  renderRows: RenderRow[]
  firstHeaderIndex: number
  scrollRef: React.RefObject<HTMLDivElement | null>
  scrollOffsetRef: React.MutableRefObject<number>
  suppressMeasurementAdjustmentUntilRef: React.MutableRefObject<number>
}) {
  const { renderRows, firstHeaderIndex, scrollRef, scrollOffsetRef } = args
  const renderRowsRef = useRef(renderRows)
  renderRowsRef.current = renderRows
  const firstHeaderIndexRef = useRef(firstHeaderIndex)
  firstHeaderIndexRef.current = firstHeaderIndex
  const stickyHeaderIndexes = useMemo(() => getStickyHeaderIndexes(renderRows), [renderRows])
  const activeStickyHeaderIndexRef = useRef<number | null>(null)
  const activeStickyHostIndexRef = useRef<number | null>(null)
  const stickyRangeStartIndexRef = useRef(0)

  const getVirtualItemKey = useCallback(
    (index: number) => {
      const row = renderRows[index]
      if (!row) {
        return `__stale_${index}`
      }
      return getRenderRowKey(row)
    },
    [renderRows]
  )
  const getExpectedVirtualRowKey = useCallback((element: Element) => {
    const index = getVirtualRowIndex(element)
    const row = index === null ? undefined : renderRowsRef.current[index]
    return row ? getRenderRowKey(row) : null
  }, [])
  const isCurrentVirtualRowElement = useCallback(
    (element: Element) => {
      const expectedKey = getExpectedVirtualRowKey(element)
      return (
        element.isConnected &&
        expectedKey !== null &&
        element.getAttribute('data-worktree-virtual-row-key') === expectedKey
      )
    },
    [getExpectedVirtualRowKey]
  )
  const measureCurrentVirtualRowElement = useCallback(
    (
      element: HTMLDivElement,
      entry: ResizeObserverEntry | undefined,
      instance: Parameters<typeof measureVirtualElementSize<HTMLDivElement>>[2]
    ) => {
      if (!isCurrentVirtualRowElement(element)) {
        const index = getVirtualRowIndex(element)
        const measured = instance.getVirtualItems().find((item) => item.index === index)
        // Why: a stale ResizeObserver row after remount would write a wrong height; return current size to no-op it.
        return (
          measured?.size ??
          estimateRenderRowSize(
            renderRowsRef.current,
            index ?? -1,
            firstHeaderIndexRef.current,
            activeStickyHeaderIndexRef.current
          )
        )
      }
      const index = getVirtualRowIndex(element)
      if (
        index !== null &&
        (renderRowsRef.current[index]?.type === 'header' ||
          renderRowsRef.current[index]?.type === 'host-header')
      ) {
        return estimateRenderRowSize(
          renderRowsRef.current,
          index,
          firstHeaderIndexRef.current,
          activeStickyHeaderIndexRef.current
        )
      }
      return measureVirtualElementSize(element, entry, instance)
    },
    [isCurrentVirtualRowElement]
  )

  const virtualizer = useVirtualizer({
    count: renderRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      estimateRenderRowSize(
        renderRows,
        index,
        firstHeaderIndex,
        activeStickyHeaderIndexRef.current
      ),
    measureElement: measureCurrentVirtualRowElement,
    // Why: TanStack memoizes rangeExtractor by identity; header indexes must be deps or sticky slots go stale.
    rangeExtractor: useCallback(
      (range: Range) => {
        stickyRangeStartIndexRef.current = range.startIndex
        return extractWorktreeVirtualRowIndexes({
          range,
          stickyHeaderIndexes,
          rows: renderRowsRef.current
        })
      },
      [stickyHeaderIndexes]
    ),
    overscan: 10,
    gap: WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP,
    // Why: the sticky group header lives inside the virtual list, so scroll math needs the same top inset as the DOM reveal.
    scrollPaddingStart: WORKTREE_SIDEBAR_REVEAL_TOP_INSET,
    isScrollingResetDelay: USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS,
    // Why: sync-flushing rich card renders in the scroll listener stalls wheel input; async + overscan keeps rows filled.
    useFlushSync: false,
    // Why: seed scrollOffset from the ref (not 0) so the first getVirtualItems() after remount picks the right rows.
    initialOffset: () => scrollOffsetRef.current,
    getItemKey: getVirtualItemKey
  })
  // Why: TanStack's default correction writes scrollTop while cards remeasure mid-wheel, which feels like rubber-banding.
  // TODO(scroll-origin-migration): wall-clock suppression misclassifies under jank; migrate to programmaticScrollMarks + restoreSignal (see CombinedDiffViewer).
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (_item, _delta, instance) =>
    shouldAdjustWorktreeSidebarMeasuredRowScroll({
      isScrolling: instance.isScrolling,
      now: window.performance.now(),
      suppressUntil: args.suppressMeasurementAdjustmentUntilRef.current
    })

  return {
    virtualizer,
    isCurrentVirtualRowElement,
    stickyHeaderIndexes,
    activeStickyHeaderIndexRef,
    activeStickyHostIndexRef,
    stickyRangeStartIndexRef
  }
}
