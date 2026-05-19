import { useCallback, useLayoutEffect, useMemo, type MutableRefObject, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'

export type VirtualizedScrollAnchor = {
  fallbackKeys?: readonly string[]
  key: string
  offset: number
} | null
export const VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT = 'orca-record-virtualized-scroll-anchor'
const RECORD_ANCHOR_SCROLL_IDLE_DELAY_MS = 150

export function shouldCancelVirtualizedScrollOffsetRestore(args: {
  hasDirectScrollInput?: () => boolean
  restoring: boolean
}): boolean {
  return args.restoring && args.hasDirectScrollInput?.() === true
}

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

  const findDomAnchor = useCallback(
    (scrollElement: TScrollElement) => {
      if (!itemElementSelector || !getItemElementKey) {
        return null
      }
      const scrollRect = scrollElement.getBoundingClientRect()
      type DomAnchorItem = { element: TItemElement; key: string; rect: DOMRect }
      const visibleItems = Array.from(
        scrollElement.querySelectorAll<TItemElement>(itemElementSelector)
      )
        .map((element) => {
          const key = getItemElementKey(element)
          if (!key || !rowIndexByKey.has(key) || !element.isConnected) {
            return null
          }
          const rect = element.getBoundingClientRect()
          if (rect.height <= 0 || rect.bottom <= scrollRect.top || rect.top >= scrollRect.bottom) {
            return null
          }
          return { element, key, rect }
        })
        .filter((item): item is DomAnchorItem => item != null)
        .sort((a, b) => a.rect.top - b.rect.top)

      const [firstVisible] = visibleItems
      if (!firstVisible) {
        return null
      }
      return {
        fallbackKeys: visibleItems.slice(1).map((item) => item.key),
        key: firstVisible.key,
        offset: Math.min(
          firstVisible.rect.height,
          Math.max(0, scrollRect.top - firstVisible.rect.top)
        )
      }
    },
    [getItemElementKey, itemElementSelector, rowIndexByKey]
  )

  const recordVirtualScrollAnchor = useCallback(
    (scrollTop: number) => {
      const virtualItems = virtualizer.getVirtualItems()
      const firstVisible = virtualItems.find((item) => item.end > scrollTop)
      const row = firstVisible ? rows[firstVisible.index] : undefined
      if (!firstVisible || !row) {
        anchorRef.current = null
        return
      }
      anchorRef.current = {
        fallbackKeys: virtualItems
          .slice(virtualItems.indexOf(firstVisible) + 1)
          .map((item) => rows[item.index])
          .filter((row): row is TRow => row != null)
          .map(getRowKey),
        key: getRowKey(row),
        offset: Math.max(0, scrollTop - firstVisible.start)
      }
    },
    [anchorRef, getRowKey, rows, virtualizer]
  )

  const recordScrollAnchor = useCallback(
    (scrollTop: number) => {
      const scrollElement = scrollElementRef.current
      if (scrollElement) {
        const domAnchor = findDomAnchor(scrollElement)
        if (domAnchor) {
          anchorRef.current = domAnchor
          return
        }
      }

      recordVirtualScrollAnchor(scrollTop)
    },
    [anchorRef, findDomAnchor, recordVirtualScrollAnchor, scrollElementRef]
  )

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
          recordScrollAnchor(el.scrollTop)
        })
      }, RECORD_ANCHOR_SCROLL_IDLE_DELAY_MS)
    }
    const recordCurrentAnchor = (): void => {
      cancelScheduledRecord()
      scrollOffsetRef.current = el.scrollTop
      recordScrollAnchor(el.scrollTop)
    }
    const onScroll = (): void => {
      if (
        shouldCancelVirtualizedScrollOffsetRestore({
          hasDirectScrollInput,
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
          recordCurrentAnchor()
          return
        }
        if (el.scrollHeight - el.clientHeight >= targetOffset) {
          el.scrollTop = targetOffset
          if (el.scrollTop === targetOffset) {
            restoring = false
            recordCurrentAnchor()
          }
        }
        return
      }
      scrollOffsetRef.current = el.scrollTop
      recordVirtualScrollAnchor(el.scrollTop)
      scheduleRecordAnchor()
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, recordCurrentAnchor)
    return () => {
      cancelScheduledRecord()
      scrollOffsetRef.current = el.scrollTop
      recordScrollAnchor(el.scrollTop)
      el.removeEventListener(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT, recordCurrentAnchor)
      el.removeEventListener('scroll', onScroll)
    }
  }, [
    recordScrollAnchor,
    recordVirtualScrollAnchor,
    scrollElementRef,
    scrollOffsetRef,
    hasDirectScrollInput
  ])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const el = scrollElementRef.current
    if (!anchor || !el) {
      return
    }
    if (virtualizer.isScrolling) {
      // Why: remeasurement during wheel scrolling can change totalSize. Restoring
      // the anchor in that window writes scrollTop and fights the user's wheel.
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
        el.scrollTop += delta
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
      scrollOffsetRef.current = el.scrollTop
      recordScrollAnchor(el.scrollTop)
      return true
    }

    if (restoreFromDomElement()) {
      return
    }

    if (!itemElementSelector && restoreFromMeasuredItem()) {
      return
    }

    // Why: after add/delete the virtualizer can initially render the wrong
    // window. Move to the anchored row, then apply the within-row offset once
    // TanStack Virtual has mounted and measured that row.
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
