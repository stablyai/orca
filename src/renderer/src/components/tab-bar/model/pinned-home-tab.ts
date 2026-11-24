import type { Bot } from '../../../../../shared/bot-types'
import { isBotHomeTab } from '../../../../../shared/bots/bot-home-tab'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { DropIndicator } from '../strip/drop-indicator'
import type { TabBarItem } from './tab-bar-item-model'

type HomeCandidate = Pick<Tab, 'id' | 'contentType' | 'entityId' | 'executionHostId' | 'isPreview'>
/** The bot whose page holds a tab on `hostId`; each tab is asked for its own host, so mixed hosts never cross. */
export type HomeBotLookup = (hostId: Tab['executionHostId']) => Pick<Bot, 'chatSessionId'> | null

/** The bot's Home among `tabs` wherever it sits; a published tab outranks a preview, as Home placement prefers. */
export function findBotHomeTab<T extends HomeCandidate>(
  tabs: readonly T[],
  homeBotFor: HomeBotLookup
): T | null {
  let preview: T | null = null
  for (const tab of tabs) {
    if (
      tab.contentType !== 'agent-session' ||
      !isBotHomeTab(tab, homeBotFor(tab.executionHostId))
    ) {
      continue
    }
    if (tab.isPreview !== true) {
      return tab
    }
    preview ??= tab
  }
  return preview
}

/** The bot's Home wherever it sits in the order; it leaves the strip for a fixed slot at the left. */
export function findPinnedHomeTabId(
  orderedItems: readonly TabBarItem[],
  homeBotFor: HomeBotLookup
): string | null {
  // Why anywhere: a restored layout, a new tab or a host's snapshot can land ahead of Home before placement reorders it.
  const chats = orderedItems.flatMap((item) => (item.type === 'agent-session' ? [item.data] : []))
  const home = findBotHomeTab(chats, homeBotFor)
  return home === null
    ? null
    : (orderedItems.find((item) => item.unifiedTabId === home.id)?.id ?? null)
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

/** A group's unified tab ids in the order the tab bar shows them: the bot's Home first, as shortcuts and drops count. */
export function withBotHomeFirstTabIds(
  orderedIds: string[],
  groupTabs: readonly HomeCandidate[],
  homeBotFor: HomeBotLookup
): string[] {
  return withPinnedHomeFirst(
    orderedIds,
    findBotHomeTab(groupTabs, homeBotFor)?.id ?? null,
    (id) => id
  )
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
