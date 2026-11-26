import { useCallback, useMemo, useReducer, useRef } from 'react'
import type React from 'react'
import {
  measureElement as measureVirtualElementSize,
  useVirtualizer
} from '@tanstack/react-virtual'
import type { Range } from '@tanstack/react-virtual'
import {
  estimateRenderRowSize,
  extractWorktreeVirtualRowIndexes,
  getStickyHeaderIndexes,
  getVirtualRowIndex,
  WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP
} from './virtual-rows'
import { getRenderRowKey } from '../listing/render-row'
import type { LineageRowProjection } from '../listing/lineage-row-projection'
import type { RenderRow } from '../listing/render-row'
import { getWorktreeSidebarRevealTopInset } from '../navigation/worktree-sidebar-reveal'
import type { ProgrammaticScrollMarks } from '@/lib/list-interaction/virtualized-scrolling/programmatic-scroll-marks'
import { createSidebarSmoothReveal } from './sidebar-smooth-reveal'
import { useAppStore } from '@/store/index'
import { isProjectTreeOn } from '../../../../../../shared/sidebar-list/project-tree-settings'
import {
  isSeparatedTreeHeader,
  TREE_LINE_ROW_HEIGHT,
  TREE_SEPARATOR_SPACE
} from '../rows/project-frame'

export type WorktreeListVirtualizer = ReturnType<typeof useWorktreeListVirtualizer>

// Read the render window inside the TanStack adapter. The instance itself mutates in place.
export function useSidebarRowsVirtualizer<TItemElement extends Element>(
  options: Parameters<typeof useVirtualizer<HTMLDivElement, TItemElement>>[0]
) {
  const virtualizer = useVirtualizer(options)
  return {
    virtualizer,
    totalSize: virtualizer.getTotalSize(),
    virtualRows: virtualizer.getVirtualItems()
  }
}

// Guard virtual row identity so recycled DOM nodes cannot overwrite another slot’s measured height.
export function useWorktreeListVirtualizer(args: {
  projection: LineageRowProjection
  renderRows: RenderRow[]
  firstHeaderIndex: number
  scrollRef: React.RefObject<HTMLDivElement | null>
  scrollOffsetRef: React.MutableRefObject<number>
  programmaticScrollMarks: ProgrammaticScrollMarks
}) {
  const { renderRows, firstHeaderIndex, scrollRef, scrollOffsetRef } = args
  const stickyHeaderIndexes = useMemo(() => getStickyHeaderIndexes(renderRows), [renderRows])
  const hasHostHeaders = stickyHeaderIndexes.some(
    (index) => renderRows[index]?.type === 'host-header'
  )
  const activeStickyHeaderIndexRef = useRef<number | null>(null)
  const activeStickyHostIndexRef = useRef<number | null>(null)
  const stickyRangeStartIndexRef = useRef(0)
  const projectTree = useAppStore((s) => isProjectTreeOn(s.settings))
  const estimateRowSize = useCallback(
    (index: number) => {
      const type = renderRows[index]?.type
      // Tree rows are single lines, far shorter than the cards the defaults assume.
      if (projectTree && (type === 'item' || type === 'folder-workspace')) {
        return TREE_LINE_ROW_HEIGHT
      }
      if (type === 'project-chats') {
        return TREE_LINE_ROW_HEIGHT + 6
      }
      return (
        estimateRenderRowSize(
          renderRows,
          index,
          firstHeaderIndex,
          activeStickyHeaderIndexRef.current
        ) +
        // Tree: a top-level entry after another gets extra room above it.
        (projectTree && isSeparatedTreeHeader(renderRows, index, firstHeaderIndex)
          ? TREE_SEPARATOR_SPACE
          : 0)
      )
    },
    [firstHeaderIndex, projectTree, renderRows]
  )

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
  const getExpectedVirtualRowKey = useCallback(
    (element: Element) => {
      const index = getVirtualRowIndex(element)
      const row = index === null ? undefined : renderRows[index]
      return row ? getRenderRowKey(row) : null
    },
    [renderRows]
  )
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
        return measured?.size ?? estimateRowSize(index ?? -1)
      }
      const index = getVirtualRowIndex(element)
      if (
        index !== null &&
        (renderRows[index]?.type === 'header' || renderRows[index]?.type === 'host-header')
      ) {
        return estimateRowSize(index)
      }
      const row = index === null ? undefined : renderRows[index]
      if (row?.type === 'item' || row?.type === 'folder-workspace') {
        return measureVirtualElementSize(element, entry, instance)
      }
      // Why: TanStack returns the cached slot size for entry-less measures, so the gap must be added to the DOM box or it compounds on every remeasure.
      const box = entry?.borderBoxSize?.[0]
      return Math.round(box ? box.blockSize : element.offsetHeight) + 6
    },
    [estimateRowSize, isCurrentVirtualRowElement, renderRows]
  )

  const [smoothScrollRevision, onRetired] = useReducer((revision: number) => revision + 1, 0)
  const smoothReveal = useMemo(
    () => createSidebarSmoothReveal({ marks: args.programmaticScrollMarks, onRetired }),
    [args.programmaticScrollMarks, onRetired]
  )
  const { virtualizer } = useSidebarRowsVirtualizer<HTMLDivElement>({
    count: renderRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const frame = args.projection.frames[index]
      return (
        estimateRowSize(index) +
        (renderRows[index]?.type === 'item' || renderRows[index]?.type === 'folder-workspace'
          ? frame.before + frame.closing + frame.after
          : 0)
      )
    },
    measureElement: measureCurrentVirtualRowElement,
    // Why: TanStack memoizes rangeExtractor by identity; header indexes must be deps or sticky slots go stale.
    rangeExtractor: useCallback(
      (range: Range) => {
        stickyRangeStartIndexRef.current = range.startIndex
        return extractWorktreeVirtualRowIndexes({
          range,
          stickyHeaderIndexes,
          rows: renderRows
        })
      },
      [renderRows, stickyHeaderIndexes]
    ),
    overscan: 10,
    gap: WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP,
    // Why: the sticky group header lives inside the virtual list, so scroll math needs the same top inset as the DOM reveal.
    scrollPaddingStart: getWorktreeSidebarRevealTopInset(hasHostHeaders),
    // Why: seed scrollOffset from the ref (not 0) so the first getVirtualItems() after remount picks the right rows.
    initialOffset: () => scrollOffsetRef.current,
    scrollToFn: smoothReveal.scrollTo,
    observeElementOffset: smoothReveal.observeOffset,
    getItemKey: getVirtualItemKey
  })

  return {
    virtualizer,
    smoothScrollRevision,
    programmaticScrollMarks: args.programmaticScrollMarks,
    rowIndexByKey: args.projection.rowIndexByKey,
    restoreSignal: args.projection.restoreSignal,
    isCurrentVirtualRowElement,
    stickyHeaderIndexes,
    activeStickyHeaderIndexRef,
    activeStickyHostIndexRef,
    stickyRangeStartIndexRef
  }
}
