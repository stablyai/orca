import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import { observeElementOffset, observeElementRect, type Range } from '@tanstack/react-virtual'
import { useSidebarRowsVirtualizer } from '@/components/sidebar/worktree-list/viewport/use-virtualizer'
import { extractPinnedVirtualRange } from '@/lib/list-interaction/pinned-virtual-range'
import {
  hasLayoutBox,
  measureVirtualRowRetainingHiddenSize
} from '@/lib/list-interaction/virtualized-hidden-row-measurement'
import { botSidebarVirtualScrollers } from './bot-sidebar-virtual-scroll'

const ESTIMATED_ENTRY_HEIGHT = 48

// Search hides the same list. Keep its last viewport and scroll offset while results are showing.
const observeListRect: typeof observeElementRect = (instance, report) =>
  observeElementRect(instance, (rect) => {
    if (rect.height > 0) {
      report(rect)
    }
  })

const observeListOffset: typeof observeElementOffset = (instance, report) =>
  observeElementOffset(instance, (offset, scrolling) => {
    if (instance.scrollElement && hasLayoutBox(instance.scrollElement)) {
      report(offset, scrolling)
    }
  })

export function BotSidebarVirtualRows<Entry extends { id: string }>({
  entries,
  listRef,
  draggingId,
  revealId,
  renderEntry
}: {
  entries: readonly Entry[]
  listRef: RefObject<HTMLDivElement | null>
  draggingId: string | null
  revealId: string | undefined
  renderEntry: (entry: Entry, index: number) => ReactNode
}): React.JSX.Element {
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const indexById = useMemo(() => new Map(entries.map(({ id }, index) => [id, index])), [entries])
  const rangeExtractor = useCallback(
    (range: Range) =>
      extractPinnedVirtualRange(
        range,
        [draggingId, revealId, focusedId].map((id) => (id ? indexById.get(id) : undefined))
      ),
    [draggingId, revealId, focusedId, indexById]
  )
  const getItemKey = useCallback((index: number) => entries[index]!.id, [entries])
  const { virtualizer, totalSize, virtualRows } = useSidebarRowsVirtualizer<Element>({
    count: entries.length,
    getScrollElement: () => listRef.current,
    getItemKey,
    estimateSize: () => ESTIMATED_ENTRY_HEIGHT,
    initialRect: { width: 0, height: ESTIMATED_ENTRY_HEIGHT },
    overscan: 6,
    rangeExtractor,
    observeElementRect: observeListRect,
    observeElementOffset: observeListOffset,
    measureElement: measureVirtualRowRetainingHiddenSize
  })
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) {
      return
    }
    botSidebarVirtualScrollers.set(list, (id) => {
      const index = indexById.get(id)
      if (index === undefined || !hasLayoutBox(list) || list.clientHeight === 0) {
        return false
      }
      const offset = virtualizer.getOffsetForIndex(index, 'start')?.[0]
      if (offset === undefined) {
        return false
      }
      // The caller reveals the measured row or a nested child after this coarse jump.
      list.scrollTop = offset
      return true
    })
    return () => {
      botSidebarVirtualScrollers.delete(list)
    }
  }, [indexById, listRef, virtualizer])

  return (
    <div className="relative shrink-0" style={{ height: totalSize }}>
      {virtualRows.map(({ key, index, start }) => {
        const entry = entries[index]!
        return (
          <div
            key={key}
            ref={virtualizer.measureElement}
            data-index={index}
            className="absolute inset-x-0"
            style={{ top: start }}
            onFocus={(event) => {
              if (event.currentTarget.contains(event.target)) {
                setFocusedId(entry.id)
              }
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setFocusedId((current) => (current === entry.id ? null : current))
              }
            }}
          >
            {renderEntry(entry, index)}
          </div>
        )
      })}
    </div>
  )
}
