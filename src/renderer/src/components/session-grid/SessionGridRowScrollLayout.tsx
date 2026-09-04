import React, { useCallback, useLayoutEffect, useMemo } from 'react'
import { useVirtualizer, type Range } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import { useStagedMountPerFrame } from '@/lib/use-staged-mount-per-frame'
import { extractVirtualRangeWithFocusedIndex } from '../sidebar/virtual-range-with-focused-index'
import { SessionGridSlots, type SessionGridLayoutProps } from './SessionGridSlots'
import { SESSION_GRID_SCROLL_CONTAINER_ID } from './use-session-grid-scroll'
import { SESSION_GRID_PADDING_PX, SESSION_GRID_ROW_GAP_PX } from './session-grid-slot-layout'

// One row above and below the viewport stays mounted so a wheel step never
// shows an empty row; more would only buy SIGWINCHes for cards nobody sees.
const ROW_OVERSCAN = 1

/**
 * Continuous row-by-row grid, virtualized by row. Only rows in the viewport
 * (plus overscan, plus the row holding the active card) render at all, and
 * their terminals mount one per frame. Rows are pixel-locked to the viewport
 * and absolutely positioned; each is a scroll-snap point except in free mode.
 */
export function SessionGridRowScrollLayout({
  items,
  totalSlotCount,
  cols,
  rowHeight,
  isFreeMode,
  scrollContainerRef,
  onScroll,
  ...slotProps
}: SessionGridLayoutProps & {
  rowHeight: number
  isFreeMode: boolean
}): React.JSX.Element {
  const rowStep = rowHeight + SESSION_GRID_ROW_GAP_PX
  const rowCount = Math.max(1, Math.ceil(totalSlotCount / cols))
  const activeIndex = slotProps.activeSessionGridTabId
    ? items.findIndex((item) => item.tabId === slotProps.activeSessionGridTabId)
    : -1
  const activeRow = activeIndex === -1 ? null : Math.floor(activeIndex / cols)

  const rangeExtractor = useCallback(
    (range: Range) => extractVirtualRangeWithFocusedIndex(range, activeRow),
    [activeRow]
  )
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => rowStep,
    overscan: ROW_OVERSCAN,
    paddingStart: SESSION_GRID_PADDING_PX,
    rangeExtractor,
    useFlushSync: false
  })
  // Why: the virtualizer caches estimateSize per row. The first render runs
  // before the container is measured (fallback height), so without a re-measure
  // rows keep the stale step while their boxes take the real height — they
  // overlap and the gap disappears. Same as the workspace board's lanes.
  useLayoutEffect(() => {
    virtualizer.measure()
  }, [rowStep, virtualizer])
  const virtualRows = virtualizer.getVirtualItems()

  const mountedTabIds = useMemo(
    () =>
      virtualRows.flatMap((row) =>
        items.slice(row.index * cols, (row.index + 1) * cols).map((item) => item.tabId)
      ),
    [virtualRows, items, cols]
  )
  const renderedTabIds = useStagedMountPerFrame(mountedTabIds)

  return (
    <div
      ref={scrollContainerRef}
      id={SESSION_GRID_SCROLL_CONTAINER_ID}
      onScroll={onScroll}
      className={cn(
        'flex-1 min-h-0 overflow-y-auto scrollbar-sleek px-3 scroll-py-3',
        !isFreeMode && 'snap-y snap-mandatory'
      )}
    >
      <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualRows.map((row) => {
          const firstSlot = row.index * cols
          const rowItems = items.slice(firstSlot, firstSlot + cols)
          const emptySlots = Math.max(
            0,
            Math.min(cols, totalSlotCount - firstSlot) - rowItems.length
          )
          return (
            <div
              key={row.key}
              className="absolute left-0 grid w-full gap-3 snap-start"
              style={{
                top: `${row.start}px`,
                height: `${rowHeight}px`,
                gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`
              }}
            >
              <SessionGridSlots
                {...slotProps}
                items={rowItems}
                emptySlotCount={emptySlots}
                emptySlotKeyPrefix={`empty-slot-${row.index}`}
                renderedTabIds={renderedTabIds}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
