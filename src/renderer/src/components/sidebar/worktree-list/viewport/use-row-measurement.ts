import { useCallback, useLayoutEffect } from 'react'
import type React from 'react'
import { useAppStore } from '@/store'
import { observeOffscreenRow } from '@/lib/window-activity/offscreen-animation-pause'
import {
  useVirtualizedScrollAnchor,
  type VirtualizedScrollAnchor
} from '@/lib/list-interaction/virtualized-scrolling/useVirtualizedScrollAnchor'
import {
  getActiveStickyIndexesForScroll,
  getVirtualRowKey,
  pruneStaleVirtualRowElementCache
} from './virtual-rows'
import { getRenderRowKey } from '../listing/render-row'
import type { RenderRow } from '../listing/render-row'
import type { WorktreeListVirtualizer } from './use-virtualizer'

const recordKeyCountCache = new WeakMap<Record<string, unknown>, number>()

export function countRecordKeysByReference(record: Record<string, unknown>): number {
  const cached = recordKeyCountCache.get(record)
  if (cached !== undefined) {
    return cached
  }
  let count = 0
  for (const key in record) {
    if (Object.hasOwn(record, key)) {
      count += 1
    }
  }
  recordKeyCountCache.set(record, count)
  return count
}

// Measure only nodes matching their virtual keys and publish sticky-header slots for rendering.
export function useVirtualRowMeasurementSync(args: {
  renderRows: RenderRow[]
  virtualization: WorktreeListVirtualizer
  scrollRef: React.RefObject<HTMLDivElement | null>
  scrollOffsetRef: React.MutableRefObject<number>
  scrollAnchorRef: React.MutableRefObject<VirtualizedScrollAnchor>
  shouldSkipScrollAnchorRestore: () => boolean
}) {
  const {
    renderRows,
    virtualization,
    scrollRef,
    scrollOffsetRef,
    scrollAnchorRef,
    shouldSkipScrollAnchorRestore
  } = args
  const { virtualizer, isCurrentVirtualRowElement } = virtualization
  const prCacheLen = useAppStore((s) => countRecordKeysByReference(s.prCache))
  const issueCacheLen = useAppStore((s) => countRecordKeysByReference(s.issueCache))
  const { rowIndexByKey } = virtualization
  const totalSize = virtualizer.getTotalSize()
  const virtualItems = virtualizer.getVirtualItems()
  const activeStickyIndexes = getActiveStickyIndexesForScroll({
    rows: renderRows,
    rangeStartIndex: virtualization.stickyRangeStartIndexRef.current,
    scrollOffset: virtualizer.scrollOffset ?? scrollOffsetRef.current,
    stickyHeaderIndexes: virtualization.stickyHeaderIndexes,
    virtualItems
  })
  virtualization.activeStickyHeaderIndexRef.current = activeStickyIndexes.groupIndex
  virtualization.activeStickyHostIndexRef.current = activeStickyIndexes.hostIndex

  const measureMountedRows = useCallback(() => {
    virtualizer.elementsCache.forEach((element) => {
      if (!isCurrentVirtualRowElement(element)) {
        return
      }
      virtualizer.measureElement(element)
    })
  }, [isCurrentVirtualRowElement, virtualizer])
  const measureVirtualRowElement = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) {
        virtualizer.measureElement(null)
        return undefined
      }
      if (!isCurrentVirtualRowElement(element)) {
        return undefined
      }
      virtualizer.measureElement(element)
      // Overscan rows sit outside the scroller's clip; their loops would still draw every frame.
      const stopObserving = observeOffscreenRow(element)
      return () => {
        stopObserving()
        virtualizer.measureElement(null)
      }
    },
    [isCurrentVirtualRowElement, virtualizer]
  )

  useLayoutEffect(() => {
    pruneStaleVirtualRowElementCache({
      activeRowKeys: rowIndexByKey,
      virtualizer
    })
    // Why: a stale retained element after delete/collapse measures 0px and corrupts the next slot; measure only key-matched rows.
    measureMountedRows()
    const frameId = window.requestAnimationFrame(measureMountedRows)
    return () => window.cancelAnimationFrame(frameId)
  }, [
    rowIndexByKey,
    prCacheLen,
    issueCacheLen,
    measureMountedRows,
    virtualizer,
    virtualization.smoothScrollRevision
  ])

  useVirtualizedScrollAnchor({
    anchorRef: scrollAnchorRef,
    getItemElementKey: getVirtualRowKey,
    getRowKey: getRenderRowKey,
    itemElementSelector: '[data-worktree-virtual-row]',
    rows: renderRows,
    rowIndexByKey: virtualization.rowIndexByKey,
    restoreSignal: virtualization.restoreSignal,
    programmaticScrollMarks: virtualization.programmaticScrollMarks,
    scrollElementRef: scrollRef,
    scrollOffsetRef,
    shouldSkipRestore: shouldSkipScrollAnchorRestore,
    totalSize,
    virtualizer
  })

  return { virtualItems, measureVirtualRowElement }
}
