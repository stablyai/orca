import { useCallback, useLayoutEffect, useMemo, type MutableRefObject, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'

export type VirtualizedScrollAnchor = { key: string; offset: number } | null

type UseVirtualizedScrollAnchorOptions<
  TRow,
  TScrollElement extends Element,
  TItemElement extends Element
> = {
  anchorRef: MutableRefObject<VirtualizedScrollAnchor>
  getRowKey: (row: TRow) => string
  rows: readonly TRow[]
  scrollElementRef: RefObject<TScrollElement | null>
  scrollOffsetRef: MutableRefObject<number>
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
  getRowKey,
  rows,
  scrollElementRef,
  scrollOffsetRef,
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

  const recordScrollAnchor = useCallback(
    (scrollTop: number) => {
      const firstVisible = virtualizer.getVirtualItems().find((item) => item.end > scrollTop)
      const row = firstVisible ? rows[firstVisible.index] : undefined
      if (!firstVisible || !row) {
        anchorRef.current = null
        return
      }
      anchorRef.current = {
        key: getRowKey(row),
        offset: Math.max(0, scrollTop - firstVisible.start)
      }
    },
    [anchorRef, getRowKey, rows, virtualizer]
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

    const onScroll = (): void => {
      if (restoring) {
        // Why: during a fresh virtualizer mount, total height may still be
        // estimate-based. Avoid persisting a browser-clamped offset as the
        // user's real position until the intended offset is reachable.
        if (el.scrollTop === targetOffset) {
          restoring = false
          scrollOffsetRef.current = el.scrollTop
          recordScrollAnchor(el.scrollTop)
          return
        }
        if (el.scrollHeight - el.clientHeight >= targetOffset) {
          el.scrollTop = targetOffset
          if (el.scrollTop === targetOffset) {
            restoring = false
            scrollOffsetRef.current = el.scrollTop
            recordScrollAnchor(el.scrollTop)
          }
        }
        return
      }
      scrollOffsetRef.current = el.scrollTop
      recordScrollAnchor(el.scrollTop)
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scrollOffsetRef.current = el.scrollTop
      recordScrollAnchor(el.scrollTop)
      el.removeEventListener('scroll', onScroll)
    }
  }, [recordScrollAnchor, scrollElementRef, scrollOffsetRef])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const el = scrollElementRef.current
    if (!anchor || !el) {
      return
    }

    const index = rowIndexByKey.get(anchor.key)
    if (index === undefined) {
      return
    }

    const restoreFromMeasuredItem = (): boolean => {
      const item = virtualizer.getVirtualItems().find((candidate) => candidate.index === index)
      if (!item) {
        return false
      }
      const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
      const nextScrollTop = Math.min(maxScrollTop, Math.max(0, item.start + anchor.offset))
      if (Math.abs(el.scrollTop - nextScrollTop) > 1) {
        el.scrollTop = nextScrollTop
      }
      scrollOffsetRef.current = el.scrollTop
      recordScrollAnchor(el.scrollTop)
      return true
    }

    if (restoreFromMeasuredItem()) {
      return
    }

    // Why: after add/delete the virtualizer can initially render the wrong
    // window. Move to the anchored row, then apply the within-row offset once
    // TanStack Virtual has mounted and measured that row.
    virtualizer.scrollToIndex(index, { align: 'start' })
    const frameId = window.requestAnimationFrame(() => {
      restoreFromMeasuredItem()
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [
    anchorRef,
    recordScrollAnchor,
    rowIndexByKey,
    scrollElementRef,
    scrollOffsetRef,
    totalSize,
    virtualizer
  ])
}
