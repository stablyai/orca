import { useCallback, useLayoutEffect, useMemo, useReducer } from 'react'
import type React from 'react'
import { useAppStore } from '@/store'
import {
  useVirtualizedScrollAnchor,
  type VirtualizedScrollAnchor
} from '@/hooks/useVirtualizedScrollAnchor'
import {
  buildLineageRowRekeyMap,
  getActiveStickyIndexesForScroll,
  getVirtualRowKey,
  pruneStaleVirtualRowElementCache
} from './virtual-rows'
import { getRenderRowKey } from '../listing/render-row'
import type { RenderRow } from '../listing/render-row'
import type { WorktreeListVirtualizer } from './use-virtualizer'
import { useVirtualRowRemovalAnimation } from './use-row-removal-animation'
import { getReconciledVirtualScrollOffset } from './scroll-offset-reconcile'

const recordKeyCountCache = new WeakMap<Record<string, unknown>, number>()

export function countRecordKeysByReference(record: Record<string, unknown>): number {
  const cached = recordKeyCountCache.get(record)
  if (cached !== undefined) {
    return cached
  }
  const count = Object.keys(record).length
  recordKeyCountCache.set(record, count)
  return count
}

// Re-measures only rows whose DOM node still matches its virtual key, and publishes the
// sticky-header slots the render pass reads out of refs.
export function useVirtualRowMeasurementSync(args: {
  renderRows: RenderRow[]
  virtualization: WorktreeListVirtualizer
  scrollRef: React.RefObject<HTMLDivElement | null>
  scrollOffsetRef: React.MutableRefObject<number>
  scrollAnchorRef: React.MutableRefObject<VirtualizedScrollAnchor>
  hasDirectScrollInput: () => boolean
  shouldSkipScrollAnchorRestore: () => boolean
}) {
  const {
    renderRows,
    virtualization,
    scrollRef,
    scrollOffsetRef,
    scrollAnchorRef,
    hasDirectScrollInput,
    shouldSkipScrollAnchorRestore
  } = args
  const { virtualizer, isCurrentVirtualRowElement } = virtualization
  const prCacheLen = useAppStore((s) => countRecordKeysByReference(s.prCache))
  const issueCacheLen = useAppStore((s) => countRecordKeysByReference(s.issueCache))
  const renderRowKeySignature = useMemo(
    () => renderRows.map(getRenderRowKey).join('\n'),
    [renderRows]
  )
  const activeRenderRowKeys = useMemo(() => new Set(renderRows.map(getRenderRowKey)), [renderRows])
  const lineageRowRekeys = useMemo(() => buildLineageRowRekeyMap(renderRows), [renderRows])
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
        return
      }
      if (!isCurrentVirtualRowElement(element)) {
        return
      }
      virtualizer.measureElement(element)
    },
    [isCurrentVirtualRowElement, virtualizer]
  )

  useLayoutEffect(() => {
    pruneStaleVirtualRowElementCache({
      activeRowKeys: activeRenderRowKeys,
      virtualizer
    })
    // Why: a stale retained element after delete/collapse measures 0px and corrupts the next slot; measure only key-matched rows.
    measureMountedRows()
    const frameId = window.requestAnimationFrame(measureMountedRows)
    return () => window.cancelAnimationFrame(frameId)
  }, [
    activeRenderRowKeys,
    prCacheLen,
    issueCacheLen,
    measureMountedRows,
    renderRowKeySignature,
    virtualizer
  ])

  const [, rerenderAfterOffsetReconcile] = useReducer((count: number) => count + 1, 0)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    const reconciled = getReconciledVirtualScrollOffset({
      believedOffset: virtualizer.scrollOffset,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      isScrolling: virtualizer.isScrolling
    })
    if (reconciled === null) {
      return
    }
    // Why: a booked-but-unhonored scroll write leaves TanStack ranging and pinning from
    // an offset the element never reached (see getReconciledVirtualScrollOffset); the
    // element is the truth, and the re-render lets range and sticky slots follow it.
    virtualizer.scrollOffset = reconciled
    virtualizer.scrollAdjustments = 0
    scrollOffsetRef.current = reconciled
    rerenderAfterOffsetReconcile()
  }, [renderRowKeySignature, scrollOffsetRef, scrollRef, totalSize, virtualizer])

  useVirtualizedScrollAnchor({
    anchorRef: scrollAnchorRef,
    getItemElementKey: getVirtualRowKey,
    getRowKey: getRenderRowKey,
    itemElementSelector: '[data-worktree-virtual-row]',
    rekeyedRowKeys: lineageRowRekeys,
    rows: renderRows,
    scrollElementRef: scrollRef,
    scrollOffsetRef,
    hasDirectScrollInput,
    shouldSkipRestore: shouldSkipScrollAnchorRestore,
    totalSize,
    virtualizer
  })

  useVirtualRowRemovalAnimation({
    renderRows,
    rekeyedRowKeys: lineageRowRekeys,
    scrollRef,
    virtualItems
  })

  return { virtualItems, measureVirtualRowElement }
}
