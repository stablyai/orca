import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type RefObject
} from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import {
  findVirtualizedDomScrollAnchor,
  getVirtualizedScrollAnchorForOffset
} from './virtualized-scroll-anchor-recording'
import { createVirtualizedScrollAnchorListener } from './virtualized-scroll-anchor-listener'
import { runVirtualizedScrollAnchorRestore } from './virtualized-scroll-anchor-restore'
import type { ProgrammaticScrollMarks } from './programmatic-scroll-marks'

export type VirtualizedScrollAnchor = {
  fallbackKeys?: readonly string[]
  key: string
  offset: number
  // Detect viewport divergence since recording; absent on anchors persisted by older versions.
  scrollTop?: number
} | null
export const VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT = 'orca-record-virtualized-scroll-anchor'
const RECORD_ANCHOR_SCROLL_IDLE_DELAY_MS = 150

type UseVirtualizedScrollAnchorOptions<
  TRow,
  TScrollElement extends Element,
  TItemElement extends Element
> = {
  anchorRef: MutableRefObject<VirtualizedScrollAnchor>
  getItemElementKey?: (element: TItemElement) => string | null
  getRowKey: (row: TRow) => string
  hasDirectScrollInput?: () => boolean
  itemElementSelector?: string
  // Marks avoid jank-sensitive input windows; callers must mark every programmatic write, including scrollToFn.
  programmaticScrollMarks?: ProgrammaticScrollMarks
  recordAnchorOnCleanup?: boolean
  // Prevent passive remount scrolls from teaching external recorders a transient row.
  recordAnchorOnScroll?: boolean
  // Follow rekeyed rows that did not move instead of falling back to a neighbor.
  rekeyedRowKeys?: ReadonlyMap<string, string>
  // Reuse a caller’s stable key/index map to avoid rebuilding it; it must agree with getRowKey over rows.
  rowIndexByKey?: ReadonlyMap<string, number>
  // Restore on structural signal changes or pending convergence; measurement churn belongs to the virtualizer.
  restoreSignal?: string
  rows: readonly TRow[]
  scrollElementRef: RefObject<TScrollElement | null>
  scrollOffsetRef: MutableRefObject<number>
  shouldSkipRestore?: () => boolean
  totalSize: number
  virtualizer: Virtualizer<TScrollElement, TItemElement>
}

/** Preserve the top visible row and within-row offset as rows disappear or change height; pixel offsets alone cannot identify the same content. */
export function useVirtualizedScrollAnchor<
  TRow,
  TScrollElement extends Element,
  TItemElement extends Element
>({
  anchorRef,
  getItemElementKey,
  getRowKey,
  hasDirectScrollInput,
  itemElementSelector,
  programmaticScrollMarks,
  recordAnchorOnCleanup = true,
  recordAnchorOnScroll = true,
  rekeyedRowKeys,
  restoreSignal,
  rowIndexByKey: providedRowIndexByKey,
  rows,
  scrollElementRef,
  scrollOffsetRef,
  shouldSkipRestore,
  totalSize,
  virtualizer
}: UseVirtualizedScrollAnchorOptions<TRow, TScrollElement, TItemElement>): void {
  const rowIndexByKey = useMemo<ReadonlyMap<string, number>>(() => {
    if (providedRowIndexByKey) {
      return providedRowIndexByKey
    }
    const indexByKey = new Map<string, number>()
    rows.forEach((row, index) => {
      indexByKey.set(getRowKey(row), index)
    })
    return indexByKey
  }, [getRowKey, providedRowIndexByKey, rows])
  // Keep the source-row anchor until rendered geometry confirms restoration.
  const pendingRestoreRef = useRef(false)

  const recordVirtualScrollAnchor = useCallback(
    (scrollTop: number) => {
      anchorRef.current = getVirtualizedScrollAnchorForOffset({
        getRowKey,
        rows,
        scrollTop,
        virtualItems: virtualizer.getVirtualItems()
      })
    },
    [anchorRef, getRowKey, rows, virtualizer]
  )

  const recordScrollAnchor = useCallback(
    (scrollTop: number) => {
      if (pendingRestoreRef.current) {
        return
      }
      const scrollElement = scrollElementRef.current
      if (scrollElement && itemElementSelector && getItemElementKey) {
        const domAnchor = findVirtualizedDomScrollAnchor<TItemElement>({
          getItemElementKey,
          itemElementSelector,
          rowIndexByKey,
          scrollElement
        })
        if (domAnchor) {
          anchorRef.current = domAnchor
          return
        }
      }

      anchorRef.current = getVirtualizedScrollAnchorForOffset({
        getRowKey,
        rows,
        scrollTop,
        virtualItems: virtualizer.getVirtualItems()
      })
    },
    [
      anchorRef,
      getItemElementKey,
      getRowKey,
      itemElementSelector,
      rowIndexByKey,
      rows,
      scrollElementRef,
      virtualizer
    ]
  )

  // Row changes must not re-register this listener: cleanup would overwrite the pre-delete anchor.
  const recordScrollAnchorRef = useRef(recordScrollAnchor)
  recordScrollAnchorRef.current = recordScrollAnchor
  const recordVirtualScrollAnchorRef = useRef(recordVirtualScrollAnchor)
  recordVirtualScrollAnchorRef.current = recordVirtualScrollAnchor
  const hasDirectScrollInputRef = useRef(hasDirectScrollInput)
  hasDirectScrollInputRef.current = hasDirectScrollInput
  const recordAnchorOnCleanupRef = useRef(recordAnchorOnCleanup)
  recordAnchorOnCleanupRef.current = recordAnchorOnCleanup
  const recordAnchorOnScrollRef = useRef(recordAnchorOnScroll)
  recordAnchorOnScrollRef.current = recordAnchorOnScroll
  const programmaticScrollMarksRef = useRef(programmaticScrollMarks)
  programmaticScrollMarksRef.current = programmaticScrollMarks
  const prevRestoreSignalRef = useRef<string | undefined>(undefined)

  useLayoutEffect(() => {
    const el = scrollElementRef.current
    if (!el) {
      return
    }

    let frameId: number | null = null
    let idleTimerId: number | null = null
    const cancelScheduledRecord = (): void => {
      if (idleTimerId !== null) {
        window.clearTimeout(idleTimerId)
        idleTimerId = null
      }
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId)
        frameId = null
      }
    }
    const scheduleRecordAnchor = (): void => {
      cancelScheduledRecord()
      idleTimerId = window.setTimeout(() => {
        idleTimerId = null
        // Defer anchor layout reads until the frame after wheel scrolling becomes idle.
        frameId = window.requestAnimationFrame(() => {
          frameId = null
          recordScrollAnchorRef.current(el.scrollTop)
        })
      }, RECORD_ANCHOR_SCROLL_IDLE_DELAY_MS)
    }
    const recordCurrentAnchor = (): void => {
      cancelScheduledRecord()
      scrollOffsetRef.current = el.scrollTop
      recordScrollAnchorRef.current(el.scrollTop)
    }
    const { onScroll, cancelMountRestore } = createVirtualizedScrollAnchorListener({
      el,
      getHasDirectScrollInput: () => hasDirectScrollInputRef.current,
      getMarks: () => programmaticScrollMarksRef.current,
      getRecordAnchorOnScroll: () => recordAnchorOnScrollRef.current,
      onProgrammaticScroll: (scrollTop) => {
        // Track our settled writes so the next divergence check cannot misread them as user input.
        scrollOffsetRef.current = scrollTop
        const anchor = anchorRef.current
        if (anchor && anchor.scrollTop !== undefined) {
          anchor.scrollTop = scrollTop
        }
      },
      pendingRestoreRef,
      recordCurrentAnchor,
      recordUserScroll: (scrollTop) => {
        scrollOffsetRef.current = scrollTop
        recordVirtualScrollAnchorRef.current(scrollTop)
        scheduleRecordAnchor()
      },
      targetOffset: scrollOffsetRef.current,
      scrollOffsetRef
    })
    const recordRequestedAnchor = (): void => {
      cancelMountRestore()
      pendingRestoreRef.current = false
      recordCurrentAnchor()
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, recordRequestedAnchor)
    return () => {
      cancelScheduledRecord()
      if (recordAnchorOnCleanupRef.current) {
        scrollOffsetRef.current = el.scrollTop
        recordScrollAnchorRef.current(el.scrollTop)
      }
      el.removeEventListener(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, recordRequestedAnchor)
      el.removeEventListener('scroll', onScroll)
    }
    // Only stable refs: row-dependent cleanup would overwrite the pre-delete anchor.
  }, [anchorRef, scrollElementRef, scrollOffsetRef])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const el = scrollElementRef.current
    const signalChanged = prevRestoreSignalRef.current !== restoreSignal
    if (el && restoreSignal !== undefined) {
      prevRestoreSignalRef.current = restoreSignal
    }
    if (!anchor || !el) {
      return
    }
    if (restoreSignal !== undefined) {
      if (!signalChanged && !pendingRestoreRef.current) {
        // Let the virtualizer handle measurement churn; restoring without structural change would fight user scrolling.
        return
      }
      // Why: pending restores own layout shifts; unmarked user scrolls disarm them in the listener.
      if (anchor.scrollTop !== undefined && !pendingRestoreRef.current) {
        const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
        const clampExplained =
          anchor.scrollTop > maxScrollTop + 1 && el.scrollTop >= maxScrollTop - 2
        const marked = programmaticScrollMarksRef.current?.hasPendingScrollOffset(
          el.scrollTop,
          maxScrollTop
        )
        if (Math.abs(el.scrollTop - anchor.scrollTop) > 1 && !clampExplained && !marked) {
          // Viewport divergence unexplained by browser clamping is user input; preserve their position.
          pendingRestoreRef.current = false
          return
        }
      }
      // Arm before input guards so skipped structural restores retry; the scroll listener disarms on user input.
      pendingRestoreRef.current = true
    }
    if (virtualizer.isScrolling && hasDirectScrollInputRef.current?.() === true) {
      // Avoid fighting active wheel input; programmatic remount scrolls still need anchor correction.
      return
    }
    if (shouldSkipRestore?.()) {
      return
    }

    return runVirtualizedScrollAnchorRestore({
      anchor,
      el,
      getItemElementKey,
      itemElementSelector,
      pendingRestoreRef,
      programmaticScrollMarks: programmaticScrollMarksRef.current,
      recordScrollAnchor,
      rekeyedRowKeys,
      rowIndexByKey,
      scrollOffsetRef,
      virtualizer
    })
  }, [
    anchorRef,
    getItemElementKey,
    itemElementSelector,
    recordScrollAnchor,
    rekeyedRowKeys,
    restoreSignal,
    rowIndexByKey,
    scrollElementRef,
    scrollOffsetRef,
    shouldSkipRestore,
    totalSize,
    virtualizer,
    virtualizer.isScrolling
  ])
}
