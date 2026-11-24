import type { DropIndicator } from './drop-indicator'
import type { TabBarItem } from '../model/tab-bar-item-model'
import { buildTabDropIndicators } from '../model/tab-bar-item-model'
import type { TabBarItemProjection } from '../model/use-tab-bar-item-projection'
import { pinnedHomeDropIndicators } from '../model/pinned-home-tab'
import type { TabStripPlan } from './tab-strip-condense-plan'
import type { ClientHostedBrowserRow } from '../../../../../shared/browser/client-hosting/client-hosted-browser-rows'

export type RenderedTabStrip = {
  /** Rendered items: a pinned Home first, then the strip's tabs not hidden behind +N. */
  orderedItems: TabBarItem[]
  /** The strip's rendered sortable ids; the pinned Home has its own context. */
  sortableIds: string[]
  dropIndicatorByVisibleId: Map<string, DropIndicator>
  clientHostedBrowserRows: readonly ClientHostedBrowserRow[]
  /** A bot's Home, outside the strip and its condense plan. */
  pinnedSortableIds: string[]
  pinnedCount: number
  pinnedHomeId: string | null
  /** Other tabs share the bar beside a pinned Home, hidden ones included. */
  stripHasTabs: boolean
  /** The strip itself renders a tab, so it keeps its 40px floor. */
  stripRendersTabs: boolean
  /** The selected entry: a client-hosted browser row that owns selection, else the active tab. */
  activeId: string | null
}

/** Hidden tabs are not rendered, so dnd-kit, windowing and the drop bar work over the rendered sequence only. */
export function resolveRenderedTabStrip({
  itemProjection,
  pinnedSortableIds,
  stripSortableIds,
  hiddenIds,
  allClientHostedBrowserRows,
  activeId
}: {
  itemProjection: TabBarItemProjection
  pinnedSortableIds: string[]
  stripSortableIds: string[]
  hiddenIds: ReadonlySet<string>
  allClientHostedBrowserRows: readonly ClientHostedBrowserRow[]
  activeId: string | null
}): RenderedTabStrip {
  const allItems = itemProjection.orderedItems
  const pinnedCount = pinnedSortableIds.length
  const pinnedHomeId = pinnedSortableIds[0] ?? null
  const orderedItems =
    hiddenIds.size === 0 ? allItems : allItems.filter((item) => !hiddenIds.has(item.id))
  const clientHostedBrowserRows =
    hiddenIds.size === 0
      ? allClientHostedBrowserRows
      : allClientHostedBrowserRows.filter((row) => !hiddenIds.has(row.browserPageId))
  return {
    orderedItems,
    sortableIds:
      hiddenIds.size === 0 ? stripSortableIds : stripSortableIds.filter((id) => !hiddenIds.has(id)),
    dropIndicatorByVisibleId: pinnedHomeDropIndicators(
      hiddenIds.size === 0
        ? itemProjection.dropIndicatorByVisibleId
        : buildTabDropIndicators(orderedItems, itemProjection.hoveredInsertion),
      pinnedHomeId,
      // Only the tab right after Home: a drop before a later one would land after hidden tabs, not after Home.
      stripSortableIds[0]
    ),
    clientHostedBrowserRows,
    pinnedSortableIds,
    pinnedCount,
    pinnedHomeId,
    stripHasTabs: allItems.length + allClientHostedBrowserRows.length > pinnedCount,
    stripRendersTabs: orderedItems.length + clientHostedBrowserRows.length > pinnedCount,
    activeId
  }
}

/**
 * Below 86px (40 tab floor + 36 "+" + 8 action padding + 2 sub-pixel slack) "+" would only clip; hide it whole so Tab
 * never lands on it. Empty groups keep it. A pinned Home beside other tabs adds a second 40px floor, so "+" hides below
 * 126px there (PINNED_HOME_EXTRA_FLOOR_PX) and the shortcut opens a new terminal instead.
 */
export function newTabButtonHideClassName(strip: RenderedTabStrip, hasHiddenTabs: boolean): string {
  if (strip.orderedItems.length + strip.clientHostedBrowserRows.length === 0 && !hasHiddenTabs) {
    return ''
  }
  return strip.pinnedCount > 0 && strip.stripHasTabs
    ? '@max-[126px]/tab-strip:hidden'
    : '@max-[86px]/tab-strip:hidden'
}

/** Beside a pinned Home, titled tabs give way to their 80px floor before Home narrows at all; an emptied strip collapses to the chip. */
export function stripSizeClassName(strip: RenderedTabStrip): string {
  return `${strip.pinnedCount > 0 ? 'shrink-[10000]' : 'shrink'} ${
    strip.stripRendersTabs ? 'min-w-10' : 'min-w-0'
  }`
}

/** The +N list marks the current tab: the pinned Home when it is active, though the plan never holds it. */
export function overflowChipActiveId(strip: RenderedTabStrip, plan: TabStripPlan): string | null {
  if (strip.pinnedHomeId !== null && strip.activeId === strip.pinnedHomeId) {
    return strip.pinnedHomeId
  }
  return plan.mode === 'condensed' ? plan.activeId : null
}
