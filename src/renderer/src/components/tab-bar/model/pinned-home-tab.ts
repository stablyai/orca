import type { Bot } from '../../../../../shared/bot-types'
import { isBotHomeTab } from '../../../../../shared/bots/bot-home-tab'
import type { DropIndicator } from '../strip/drop-indicator'
import type { TabBarItem } from './tab-bar-item-model'

/** The bot's Home wherever it sits in the order; it leaves the strip for a fixed slot at the left. */
export function findPinnedHomeTabId(
  orderedItems: readonly TabBarItem[],
  homeBot: Pick<Bot, 'chatSessionId'> | null
): string | null {
  if (homeBot === null) {
    return null
  }
  // Why anywhere: a restored layout, a new tab or a host's snapshot can land ahead of Home before placement reorders it.
  const home = orderedItems.find(
    (item) => item.type === 'agent-session' && isBotHomeTab(item.data, homeBot)
  )
  return home?.id ?? null
}

/** `items` with the pinned Home first; the same array when it already leads or nothing is pinned. */
export function withPinnedHomeFirst<T>(
  items: T[],
  pinnedHomeId: string | null,
  idOf: (item: T) => string
): T[] {
  if (pinnedHomeId === null) {
    return items
  }
  const index = items.findIndex((item) => idOf(item) === pinnedHomeId)
  if (index <= 0) {
    return items
  }
  return [items[index]!, ...items.slice(0, index), ...items.slice(index + 1)]
}

/** The strip's ids: every tab but the pinned Home. */
export function stripSortableIdsWithoutPinnedHome(
  sortableIds: string[],
  pinnedHomeId: string | null
): string[] {
  return pinnedHomeId === null ? sortableIds : sortableIds.filter((id) => id !== pinnedHomeId)
}

/** "Insert after the pinned Home" marks Home's right edge: the first strip tab can be hidden or unmounted. */
export function pinnedHomeDropIndicators(
  indicators: Map<string, DropIndicator>,
  pinnedHomeId: string | null,
  firstStripId: string | undefined
): Map<string, DropIndicator> {
  if (pinnedHomeId === null || firstStripId === undefined) {
    return indicators
  }
  if (indicators.get(firstStripId) !== 'left') {
    return indicators
  }
  const moved = new Map(indicators)
  moved.delete(firstStripId)
  moved.set(pinnedHomeId, 'right')
  return moved
}
