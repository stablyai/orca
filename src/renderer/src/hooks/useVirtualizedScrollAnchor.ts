import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type RefObject
} from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import { shouldCancelVirtualizedScrollOffsetRestore } from './virtualizedScrollOffsetRestore'
import {
  findVirtualizedDomScrollAnchor,
  getVirtualizedScrollAnchorForOffset
} from './virtualized-scroll-anchor-recording'

export type VirtualizedScrollAnchor = {
  fallbackKeys?: readonly string[]
  key: string
  offset: number
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
  recordAnchorOnCleanup?: boolean
  // Why: some callers record user scroll anchors outside this hook; passive
  // programmatic scroll events during remount must not teach them a transient row.
  recordAnchorOnScroll?: boolean
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
  recordAnchorOnCleanup = true,
  recordAnchorOnScroll = true,
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

  useLayoutEffect(() => {
    const el = scrollElementRef.current
    if (!el) {
      return
    }

    const targetOffset = scrollOffsetRef.current
    let restoring = targetOffset > 0
    if (restoring) {
      el.scrollTop = targetOffset
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
    const onScroll = (): void => {
      if (
        shouldCancelVirtualizedScrollOffsetRestore({
          hasDirectScrollInput: hasDirectScrollInputRef.current,
          restoring
        })
      ) {
        // Why: direct wheel/touch input means the user has taken control of the
        // viewport. Treat the current offset as intentional instead of snapping
        // back to a stale persisted offset while restoration is still pending.
        restoring = false
        recordCurrentAnchor()
        return
      }
      if (restoring) {
        // Why: during a fresh virtualizer mount, total height may still be
        // estimate-based. Avoid persisting a browser-clamped offset as the
        // user's real position until the intended offset is reachable.
        if (el.scrollTop === targetOffset) {
          restoring = false
          if (recordAnchorOnScrollRef.current) {
            recordCurrentAnchor()
          } else {
            scrollOffsetRef.current = el.scrollTop
          }
          return
        }
        if (el.scrollHeight - el.clientHeight >= targetOffset) {
          el.scrollTop = targetOffset
          if (el.scrollTop === targetOffset) {
            restoring = false
            if (recordAnchorOnScrollRef.current) {
              recordCurrentAnchor()
            } else {
              scrollOffsetRef.current = el.scrollTop
            }
          }
        }
        return
      }
      if (!recordAnchorOnScrollRef.current) {
        return
      }
      scrollOffsetRef.current = el.scrollTop
      recordVirtualScrollAnchorRef.current(el.scrollTop)
      scheduleRecordAnchor()
    }

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
  }, [scrollElementRef, scrollOffsetRef])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const el = scrollElementRef.current
    if (!anchor || !el) {
      return
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

    const resolvedKey = rowIndexByKey.has(anchor.key)
      ? anchor.key
      : anchor.fallbackKeys?.find((key) => rowIndexByKey.has(key))
    if (!resolvedKey) {
      return
    }
    const index = rowIndexByKey.get(resolvedKey)
    if (index === undefined) {
      return
    }
    const offset = resolvedKey === anchor.key ? anchor.offset : 0

    const restoreFromDomElement = (): boolean => {
      if (!itemElementSelector || !getItemElementKey) {
        return false
      }
      const element =
        Array.from(el.querySelectorAll<TItemElement>(itemElementSelector)).find(
          (candidate) => getItemElementKey(candidate) === resolvedKey && candidate.isConnected
        ) ?? null
      if (!element) {
        return false
      }
      const scrollRect = el.getBoundingClientRect()
      const rect = element.getBoundingClientRect()
      const desiredTop = scrollRect.top - offset
      const delta = rect.top - desiredTop
      if (Math.abs(delta) > 1) {
        // Why: this scroll write is still part of restore; keep the target
        // anchor until a later layout confirms the intended row is in place.
        el.scrollTop += delta
        scrollOffsetRef.current = el.scrollTop
        return true
      }
      scrollOffsetRef.current = el.scrollTop
      recordScrollAnchor(el.scrollTop)
      return true
    }

    const restoreFromMeasuredItem = (): boolean => {
      const item = virtualizer.getVirtualItems().find((candidate) => candidate.index === index)
      if (!item) {
        return false
      }
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
      const nextScrollTop = Math.min(maxScrollTop, Math.max(0, item.start + offset))
      if (Math.abs(el.scrollTop - nextScrollTop) > 1) {
        el.scrollTop = nextScrollTop
      }
      // Why: measured fallback can run while TanStack's virtual window is
      // transitional, so recording here can replace the target with a wrong row.
      scrollOffsetRef.current = el.scrollTop
      return true
    }

    if (restoreFromDomElement()) {
      return
    }

    // Why: right after a delete the virtualizer can briefly render the wrong
    // window, so the anchor row's DOM node isn't mounted yet even though the
    // virtualizer still has its measured slot. Pin from that measured start
    // (preserving the within-row offset) before falling back to scrollToIndex,
    // whose align:'start' snaps the row to the viewport top and visibly jumps.
    if (restoreFromMeasuredItem()) {
      return
    }

    // Why: the anchored row is outside the virtualizer's current window — no
    // DOM node and no measured slot. Bring it in, then apply the within-row
    // offset once TanStack Virtual has mounted and measured that row.
    virtualizer.scrollToIndex(index, { align: 'start' })
    const frameId = window.requestAnimationFrame(() => {
      if (!restoreFromDomElement()) {
        restoreFromMeasuredItem()
      }
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [
    anchorRef,
    getItemElementKey,
    itemElementSelector,
    recordScrollAnchor,
    rowIndexByKey,
    scrollElementRef,
    scrollOffsetRef,
    shouldSkipRestore,
    totalSize,
    virtualizer,
    virtualizer.isScrolling
  ])
}
