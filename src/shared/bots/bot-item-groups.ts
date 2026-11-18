// How a bot's Items tab groups its items: Needs you, In progress, Planned, Snoozed, Stale and Closed. Rows
// changed since the owner last opened the tab come first, then the latest change; Snoozed, soonest back first.
import type { BotItemsStale } from '../bot-types'
import type { BotChatOrigin, BotChatTreeChat } from './bot-chat-tree'
import type { BotNeed } from './bot-now'
import {
  BOT_ITEM_DEFAULT_STALE_DAYS,
  botItemActivityAt,
  isOpenBotItemStatus,
  isBotItemSnoozed,
  isBotItemStale,
  botItemNeedsYouStaleAt,
  parseBotItemEventId,
  type BotItem,
  type BotItemChatKind
} from './bot-items'

/** Rows a group shows before "Show N more". */
export const BOT_ITEM_GROUP_ROWS = 5

export const BOT_ITEM_GROUP_IDS = [
  'needs_you',
  'working',
  'planned',
  'snoozed',
  'stale',
  'closed'
] as const
export type BotItemGroupId = (typeof BOT_ITEM_GROUP_IDS)[number]

/** Groups that start folded on the desktop and the phone; the rest start open. */
export const BOT_ITEM_GROUPS_FOLDED_BY_DEFAULT: ReadonlySet<BotItemGroupId> = new Set([
  'planned',
  'snoozed',
  'stale'
])

export type BotItemGroups = Record<BotItemGroupId, BotItem[]>

/** The tab's filter: one chat (null: all), and only what needs the owner. */
export type BotItemFilter = { chatId: string | null; needsYou: boolean }

export const BOT_ITEM_NO_FILTER: BotItemFilter = { chatId: null, needsYou: false }

/** The bot's stale setting in days; null: never. */
export function botItemStaleDays(stale: BotItemsStale | undefined): number | null {
  return stale === 'never' ? null : (stale ?? BOT_ITEM_DEFAULT_STALE_DAYS)
}

/** Changed by anyone but the owner since the owner last opened this bot's Items tab. */
export function isBotItemUnseen(
  item: Pick<BotItem, 'othersLastEventId'>,
  seenEventId: string
): boolean {
  return (
    (parseBotItemEventId(item.othersLastEventId) ?? 0) > (parseBotItemEventId(seenEventId) ?? 0)
  )
}

export function botItemGroupOf(
  item: BotItem,
  staleDays: number | null,
  now: number
): BotItemGroupId {
  if (item.status === 'done' || item.status === 'canceled') {
    return 'closed'
  }
  if (isBotItemSnoozed(item, now)) {
    return 'snoozed'
  }
  return isBotItemStale(item, staleDays, now) ? 'stale' : item.status
}

export function filterBotItems(items: readonly BotItem[], filter: BotItemFilter): BotItem[] {
  return items.filter(
    (item) =>
      (filter.chatId === null || item.chat.id === filter.chatId) &&
      (!filter.needsYou || item.status === 'needs_you')
  )
}

/** Each item by the Dispatches it links, the lineage's newest too, so a worker's ask finds its item. */
export function botItemsByDispatch(items: readonly BotItem[]): Map<string, BotItem> {
  const byDispatch = new Map<string, BotItem>()
  for (const item of items) {
    for (const link of item.links) {
      if (link.kind === 'dispatch') {
        byDispatch.set(link.ref, item)
        if (link.latest) {
          byDispatch.set(link.latest, item)
        }
      }
    }
  }
  return byDispatch
}

/** The chat an ask belongs to, as the filter names chats: its own, or for a worker its item's chat,
 *  else Home Chat's when Home Chat started it. Null for a sign-in or access request. */
export function botNeedChat(
  need: BotNeed<unknown, unknown>,
  homeChatId: string | null,
  itemOf: (dispatchId: string) => Pick<BotItem, 'chat'> | null
): string | null {
  switch (need.kind) {
    case 'chat':
      return homeChatId
    case 'side-chat':
      return need.sessionId
    case 'session': {
      const { row } = need
      if (row.kind !== 'worker') {
        return row.sessionId
      }
      const item = row.dispatchId ? itemOf(row.dispatchId) : null
      return item?.chat.id ?? (row.origin.kind === 'chat' ? homeChatId : null)
    }
    case 'connector':
    case 'access':
      return null
  }
}

/** Orca's asks a filter shows beside its items: a chat's own ask and its workers' asks. A sign-in or
 *  an access request is no chat's (`chatOf` null), so only an unfiltered or Needs-you-only list has it. */
export function filterBotNeeds<N>(
  needs: readonly N[],
  filter: BotItemFilter,
  chatOf: (need: N) => string | null
): readonly N[] {
  return filter.chatId === null ? needs : needs.filter((need) => chatOf(need) === filter.chatId)
}

export function groupBotItems(
  items: readonly BotItem[],
  staleDays: number | null,
  now: number,
  seenEventId: string
): BotItemGroups {
  const groups: BotItemGroups = {
    needs_you: [],
    working: [],
    planned: [],
    snoozed: [],
    stale: [],
    closed: []
  }
  for (const item of items) {
    groups[botItemGroupOf(item, staleDays, now)].push(item)
  }
  const unseen = (item: BotItem) => Number(isBotItemUnseen(item, seenEventId))
  const activity = (item: BotItem) => botItemActivityAt(item, now)
  for (const [id, rows] of Object.entries(groups)) {
    rows.sort(
      id === 'snoozed'
        ? (a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0) || b.number - a.number
        : (a, b) => unseen(b) - unseen(a) || activity(b) - activity(a) || b.number - a.number
    )
  }
  return groups
}

/** The tab's badge: items in Needs you that aren't stale or snoozed. */
export function botItemsNeedingOwner(
  items: readonly BotItem[],
  staleDays: number | null,
  now: number
): number {
  return items.filter((item) => botItemGroupOf(item, staleDays, now) === 'needs_you').length
}

/** The same count for every bot at once, from each Needs you item's bot, last activity and snooze: what
 *  the bot list carries so a phone shows it before reading any items; and when the count next changes,
 *  as a counted item goes stale or a snoozed one comes back (`staleInMs`, named for the first). */
export function botItemsNeedingOwnerByBot(
  rows: readonly { botId: string; lastActivityAt: number; snoozedUntil: number | null }[],
  bots: readonly { id: string; itemsStale?: BotItemsStale }[],
  now: number
): { counts: Record<string, number>; staleInMs?: number } {
  const staleDays = new Map(bots.map((bot) => [bot.id, botItemStaleDays(bot.itemsStale)]))
  const counts: Record<string, number> = {}
  let staleInMs: number | undefined
  const next = (left: number) => {
    staleInMs = Math.min(staleInMs ?? left, left)
  }
  for (const row of rows) {
    const days = staleDays.get(row.botId)
    if (days === undefined) {
      continue
    }
    const item = { status: 'needs_you' as const, links: [], ...row }
    if (isBotItemSnoozed(item, now)) {
      next((row.snoozedUntil ?? now) - now)
    } else if (!isBotItemStale(item, days, now)) {
      counts[row.botId] = (counts[row.botId] ?? 0) + 1
      if (days !== null) {
        next(botItemNeedsYouStaleAt(botItemActivityAt(item, now), days) - now)
      }
    }
  }
  return { counts, ...(staleInMs !== undefined ? { staleInMs } : {}) }
}

export type BotItemChatChoice = {
  chatId: string
  title: string | null
  kind: BotItem['chat']['kind']
  count: number
}

const TREE_KINDS: Record<BotChatOrigin, BotItemChatKind> = {
  home: 'home',
  side: 'chat',
  automation: 'automation',
  slack: 'thread',
  linear: 'thread',
  github: 'thread'
}

/** The chat filter's choices: the bot's chats and any chat an item names, each with its open items
 *  (all open items are loaded), Home Chat first. */
export function botItemChats(
  items: readonly BotItem[],
  treeChats: readonly Pick<BotChatTreeChat, 'chatId' | 'title' | 'origin'>[] = []
): BotItemChatChoice[] {
  const chats = new Map<string, BotItemChatChoice>()
  for (const chat of treeChats) {
    chats.set(chat.chatId, {
      chatId: chat.chatId,
      title: chat.title,
      kind: TREE_KINDS[chat.origin],
      count: 0
    })
  }
  for (const item of items) {
    const entry = chats.get(item.chat.id) ?? {
      chatId: item.chat.id,
      title: item.chat.title,
      kind: item.chat.kind,
      count: 0
    }
    if (isOpenBotItemStatus(item.status)) {
      entry.count += 1
    }
    chats.set(item.chat.id, entry)
  }
  return [...chats.values()].sort(
    (a, b) => Number(b.kind === 'home') - Number(a.kind === 'home') || b.count - a.count
  )
}
