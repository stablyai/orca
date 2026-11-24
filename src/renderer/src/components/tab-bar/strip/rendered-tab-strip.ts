import type { DropIndicator } from './drop-indicator'
import type { TabBarItem } from '../model/tab-bar-item-model'
import type { TabBarItemProjection } from '../model/use-tab-bar-item-projection'
import { pinnedHomeDropIndicators } from '../model/pinned-home-tab'
import type { ClientHostedBrowserRow } from '../../../../../shared/browser/client-hosting/client-hosted-browser-rows'

export type RenderedTabStrip = {
  /** Rendered items: a pinned Home first, then the strip's tabs. */
  orderedItems: TabBarItem[]
  /** The strip's sortable ids; the pinned Home has its own context. */
  sortableIds: string[]
  dropIndicatorByVisibleId: Map<string, DropIndicator>
  clientHostedBrowserRows: readonly ClientHostedBrowserRow[]
  /** A bot's Home, outside the strip's scroll. */
  pinnedSortableIds: string[]
  pinnedCount: number
  /** Other tabs share the bar beside a pinned Home. */
  stripHasTabs: boolean
}

export function resolveRenderedTabStrip({
  itemProjection,
  pinnedSortableIds,
  stripSortableIds,
  clientHostedBrowserRows
}: {
  itemProjection: TabBarItemProjection
  pinnedSortableIds: string[]
  stripSortableIds: string[]
  clientHostedBrowserRows: readonly ClientHostedBrowserRow[]
}): RenderedTabStrip {
  const orderedItems = itemProjection.orderedItems
  const pinnedCount = pinnedSortableIds.length
  return {
    orderedItems,
    sortableIds: stripSortableIds,
    dropIndicatorByVisibleId: pinnedHomeDropIndicators(
      itemProjection.dropIndicatorByVisibleId,
      pinnedSortableIds[0] ?? null,
      stripSortableIds[0]
    ),
    clientHostedBrowserRows,
    pinnedSortableIds,
    pinnedCount,
    stripHasTabs: orderedItems.length + clientHostedBrowserRows.length > pinnedCount
  }
}

/**
 * Below 86px (40 tab floor + 36 "+" + 8 action padding + 2 sub-pixel slack) "+" would only clip; hide it whole so Tab
 * never lands on it. Empty groups keep it. A pinned Home beside other tabs adds a second 40px floor, so "+" hides below
 * 126px there.
 */
export function newTabButtonHideClassName(strip: RenderedTabStrip): string {
  if (strip.orderedItems.length + strip.clientHostedBrowserRows.length === 0) {
    return ''
  }
  return strip.pinnedCount > 0 && strip.stripHasTabs
    ? '@max-[126px]/tab-strip:hidden'
    : '@max-[86px]/tab-strip:hidden'
}

/** Beside a pinned Home the scrolling strip gives way to its 40px floor before Home narrows at all. */
export function stripSizeClassName(strip: RenderedTabStrip): string {
  return `${strip.pinnedCount > 0 ? 'shrink-[10000]' : 'shrink'} ${
    strip.stripHasTabs ? 'min-w-10' : 'min-w-0'
  }`
}
