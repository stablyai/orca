import React, { useCallback, useMemo } from 'react'
import { useStagedMountPerFrame } from '@/lib/use-staged-mount-per-frame'
import { SessionGridSlots, type SessionGridLayoutProps } from './SessionGridSlots'
import { SESSION_GRID_SCROLL_CONTAINER_ID } from './use-session-grid-scroll'
import type { SessionGridItem } from '../../../../shared/session-grid-types'

// The current page and its neighbours render; anything further is a spacer.
const PAGE_WINDOW = 1

/**
 * Page-by-page block grid: each page is one viewport and a mandatory snap
 * point. Pages are cut from the slot total, so the trailing empty row lands
 * on its own page when the last row of cards is full. Only the pages around
 * the current one render; the rest are blank spacers of the same height, so
 * scroll offsets and snap points stay honest.
 */
export function SessionGridPageScrollLayout({
  items,
  totalSlotCount,
  cols,
  rowsPerView,
  currentPage,
  scrollContainerRef: _scrollContainerRef,
  setScrollContainer,
  onScroll,
  ...slotProps
}: SessionGridLayoutProps & {
  rowsPerView: number
  currentPage: number
}): React.JSX.Element {
  const itemsPerPage = cols * rowsPerView
  const pages = useMemo(() => {
    const result: { items: SessionGridItem[]; emptySlots: number }[] = []
    for (let start = 0; start < totalSlotCount; start += itemsPerPage) {
      const pageItems = items.slice(start, start + itemsPerPage)
      const slotsOnPage = Math.min(itemsPerPage, totalSlotCount - start)
      result.push({ items: pageItems, emptySlots: slotsOnPage - pageItems.length })
    }
    return result
  }, [items, itemsPerPage, totalSlotCount])

  const isPageRendered = useCallback(
    (pageIdx: number): boolean => Math.abs(pageIdx - currentPage) <= PAGE_WINDOW,
    [currentPage]
  )
  const mountedTabIds = useMemo(
    () =>
      pages.flatMap((page, pageIdx) =>
        isPageRendered(pageIdx) ? page.items.map((i) => i.tabId) : []
      ),
    [pages, isPageRendered]
  )
  const renderedTabIds = useStagedMountPerFrame(mountedTabIds)

  return (
    <div
      ref={setScrollContainer}
      id={SESSION_GRID_SCROLL_CONTAINER_ID}
      onScroll={onScroll}
      className="flex-1 min-h-0 overflow-y-auto scrollbar-sleek snap-y snap-mandatory"
    >
      {pages.map(({ items: pageItems, emptySlots }, pageIdx) => {
        if (!isPageRendered(pageIdx)) {
          return (
            <div
              key={`session-grid-page-${pageIdx}`}
              id={`session-grid-page-${pageIdx}`}
              className="h-full w-full snap-start snap-always shrink-0"
            />
          )
        }
        return (
          <div
            key={`session-grid-page-${pageIdx}`}
            id={`session-grid-page-${pageIdx}`}
            className="h-full w-full snap-start snap-always shrink-0 p-3 grid gap-3"
            style={{
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${rowsPerView}, minmax(0, 1fr))`
            }}
          >
            <SessionGridSlots
              {...slotProps}
              items={pageItems}
              emptySlotCount={emptySlots}
              emptySlotKeyPrefix={`empty-slot-${pageIdx}`}
              renderedTabIds={renderedTabIds}
            />
          </div>
        )
      })}
    </div>
  )
}
