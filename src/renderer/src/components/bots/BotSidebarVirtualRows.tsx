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

export function BotSidebarVirtualRows<Entry extends { id: string; nestedIds?: readonly string[] }>({
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
  // A row listed inside another (a group's member) is found through the row holding it; a bot
  // listed under two groups is found under the first.
  const indexById = useMemo(() => {
    const byId = new Map<string, number>()
    entries.forEach(({ id, nestedIds = [] }, index) => {
      for (const key of [id, ...nestedIds]) {
        if (!byId.has(key)) {
          byId.set(key, index)
        }
      }
    })
    return byId
  }, [entries])
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
      // A rendered row that changed while search hid the list keeps its old size until
      // ResizeObserver reports it, but in flow its real height already sets how far the list
      // scrolls: a jump worked out from the old size stops short of the target. Read them first.
      for (const row of virtualizer.elementsCache.values()) {
        if (row.isConnected) {
          virtualizer.resizeItem(
            virtualizer.indexFromElement(row),
            Math.round(row.getBoundingClientRect().height)
          )
        }
      }
      // resizeItem invalidates offsets, but getOffsetForIndex reads the cached values.
      virtualizer.getTotalSize()
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

  // Rendered entries sit in normal flow, with spacers standing in for the rows not rendered. A
  // bot's entry grows after its first measure (its chats load, it unfolds); placed at a measured
  // offset, a stale measure drew the next entry over those lines. In flow, the next entry always
  // starts below it, and a stale measure can only misjudge the spacers.
  const { gaps, tail } = flowSpacers(virtualRows, totalSize)
  return (
    <div className="shrink-0">
      {/* flatMap, not map: nested arrays would key rows by window position and remount them on scroll. */}
      {virtualRows.flatMap(({ key, index }, position) => {
        const entry = entries[index]!
        const gap = gaps[position]!
        return [
          gap > 0 ? <div key={`gap:${key}`} aria-hidden style={{ height: gap }} /> : null,
          <div
            key={key}
            ref={virtualizer.measureElement}
            data-index={index}
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
        ]
      })}
      {tail > 0 ? <div aria-hidden style={{ height: tail }} /> : null}
    </div>
  )
}

/** Before each rendered row, the height of the rows skipped since the previous one; then the rest. */
export function flowSpacers(
  rows: readonly { start: number; end: number }[],
  totalSize: number
): { gaps: number[]; tail: number } {
  const gaps: number[] = []
  let end = 0
  for (const row of rows) {
    gaps.push(Math.max(0, row.start - end))
    end = row.end
  }
  return { gaps, tail: Math.max(0, totalSize - end) }
}
