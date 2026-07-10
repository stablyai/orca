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
  // Why: the scroll offset this anchor was derived from lets restore detect
  // that the viewport moved (user scroll or clamp) after the anchor was
  // recorded. Optional: anchors persisted before this field existed lack it.
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
  // Why: marks classify scroll events by origin (self-initiated vs user)
  // instead of wall-clock input windows, which misclassify under main-thread
  // jank. Callers opting in must route every programmatic scroll they issue
  // through marks (including the virtualizer's scrollToFn).
  programmaticScrollMarks?: ProgrammaticScrollMarks
  recordAnchorOnCleanup?: boolean
  // Why: some callers record user scroll anchors outside this hook; passive
  // programmatic scroll events during remount must not teach them a transient row.
  recordAnchorOnScroll?: boolean
  // Why: when provided, anchor restore runs only when this value changes
  // (structural row changes) or while a prior restore is still converging —
  // not on every totalSize/isScrolling tick. Measurement-driven shifts are the
  // virtualizer's own scroll-adjustment job.
  restoreSignal?: string
  rows: readonly TRow[]
  scrollElementRef: RefObject<TScrollElement | null>
  scrollOffsetRef: MutableRefObject<number>
  shouldSkipRestore?: () => boolean
  totalSize: number
  virtualizer: Virtualizer<TScrollElement, TItemElement>
}

/**
 * Preserves a virtualized scroller by visible row identity, not just pixels.
 *
 * Raw scrollTop is not enough when rows are removed or their measured heights
 * change: the same pixel can point at a different item. The anchor keeps the
 * top visible row plus its within-row offset and restores that after the
 * virtualizer has rebuilt or remeasured.
 */
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
  restoreSignal,
  rows,
  scrollElementRef,
  scrollOffsetRef,
  shouldSkipRestore,
  totalSize,
  virtualizer
}: UseVirtualizedScrollAnchorOptions<TRow, TScrollElement, TItemElement>): void {
  const rowIndexByKey = useMemo(() => {
    const indexByKey = new Map<string, number>()
    rows.forEach((row, index) => {
      indexByKey.set(getRowKey(row), index)
    })
    return indexByKey
  }, [getRowKey, rows])

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

  // Why: row changes must not re-register the scroll listener; cleanup records
  // an anchor and would overwrite the pre-delete anchor after the row is gone.
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
  // Why: true while a restore has written toward the anchor but the anchored
  // row's position is not yet confirmed; re-arms the restore effect across
  // totalSize ticks until it converges or the user scrolls.
  const pendingRestoreRef = useRef(false)

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
        // Why: recording the row anchor reads layout. Wait until wheel scrolling
        // is idle, then do the read on the next frame instead of the input path.
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
    const onScroll = createVirtualizedScrollAnchorListener({
      el,
      getHasDirectScrollInput: () => hasDirectScrollInputRef.current,
      getMarks: () => programmaticScrollMarksRef.current,
      getRecordAnchorOnScroll: () => recordAnchorOnScrollRef.current,
      onProgrammaticScroll: (scrollTop) => {
        // Why: our own settled writes must keep the divergence bookkeeping in
        // sync, or the restore gate reads them as user scrolling and drops
        // the next structural restore.
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

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, recordCurrentAnchor)
    return () => {
      cancelScheduledRecord()
      if (recordAnchorOnCleanupRef.current) {
        scrollOffsetRef.current = el.scrollTop
        recordScrollAnchorRef.current(el.scrollTop)
      }
      el.removeEventListener(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, recordCurrentAnchor)
      el.removeEventListener('scroll', onScroll)
    }
    // Why: only stable refs may appear here; row-derived values would rerun
    // cleanup after a delete and overwrite the pre-delete anchor.
  }, [anchorRef, scrollElementRef, scrollOffsetRef])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const el = scrollElementRef.current
    if (!anchor || !el) {
      return
    }
    if (restoreSignal !== undefined) {
      const signalChanged = prevRestoreSignalRef.current !== restoreSignal
      prevRestoreSignalRef.current = restoreSignal
      if (!signalChanged && !pendingRestoreRef.current) {
        // Why: no structural row change and no restore mid-convergence. Pure
        // measurement churn is compensated by the virtualizer's own scroll
        // adjustment; restoring here would fight concurrent user scrolling.
        return
      }
      if (anchor.scrollTop !== undefined) {
        const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
        const clampExplained =
          anchor.scrollTop > maxScrollTop + 1 && el.scrollTop >= maxScrollTop - 2
        if (Math.abs(el.scrollTop - anchor.scrollTop) > 1 && !clampExplained) {
          // Why: the viewport moved after this anchor was recorded and no
          // browser clamp explains it — the user scrolled. Their position
          // wins; restoring would undo their input.
          pendingRestoreRef.current = false
          return
        }
      }
      // Why: armed before the skip guards below, so a restore owed to a
      // signal change survives being skipped during active input and retries
      // on the next tick instead of being silently consumed. User scrolls
      // disarm it via the scroll listener.
      pendingRestoreRef.current = true
    }
    if (virtualizer.isScrolling && hasDirectScrollInputRef.current?.() === true) {
      // Why: remeasurement during wheel scrolling can change totalSize. Restoring
      // the anchor in that window writes scrollTop and fights the user's wheel.
      // Programmatic scrolls during remount still need anchor correction.
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
      rowIndexByKey,
      scrollOffsetRef,
      virtualizer
    })
  }, [
    anchorRef,
    getItemElementKey,
    itemElementSelector,
    recordScrollAnchor,
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
