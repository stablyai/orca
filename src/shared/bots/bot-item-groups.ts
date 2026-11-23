// How a bot's Items tab groups its items: Needs you, In progress, Planned, Snoozed, Stale and Closed. Rows
// changed since the owner last opened the tab come first, then the latest change; Snoozed, soonest back first.
import type { BotItemsStale } from '../bot-types'
import type { BotNeed } from './bot-now'
import {
  BOT_ITEM_DEFAULT_STALE_DAYS,
  botItemActivityAt,
  isBotItemSnoozed,
  isBotItemStale,
  botItemNeedsYouStaleAt,
  parseBotItemEventId,
  type BotItem
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
  'stale',
  'closed'
])

export type BotItemGroups = Record<BotItemGroupId, BotItem[]>

/** The tab's filter: these chats' items and these bots' (null: all), and only what needs the owner. A
 *  bot's page sets only Needs you; a group's page picks its rooms' member sessions and some members. */
export type BotItemFilter = {
  chatIds: readonly string[] | null
  botIds: readonly string[] | null
  needsYou: boolean
}

export const BOT_ITEM_NO_FILTER: BotItemFilter = { chatIds: null, botIds: null, needsYou: false }

export function isBotItemFilterOn(filter: BotItemFilter): boolean {
  return filter.chatIds !== null || filter.botIds !== null || filter.needsYou
}

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
      (filter.chatIds === null || filter.chatIds.includes(item.chat.id)) &&
      (filter.botIds === null || filter.botIds.includes(item.owner.botId)) &&
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
    // Answered for the bot as a whole, so it lists under its Home Chat.
    case 'paired-ask':
      return homeChatId
  }
}

/** One bot's asks a filter shows beside its items: a chat's own ask and its workers' asks. A sign-in or
 *  an access request is no chat's (`chatOf` null), so only a list of every chat has it. */
export function filterBotNeeds<N>(
  needs: readonly N[],
  filter: BotItemFilter,
  chatOf: (need: N) => string | null
): readonly N[] {
  const { chatIds } = filter
  if (chatIds === null) {
    return needs
  }
  return needs.filter((need) => {
    const chat = chatOf(need)
    return chat !== null && chatIds.includes(chat)
  })
}

export function groupBotItems(
  items: readonly BotItem[],
  staleDays: number | null,
  now: number,
  seenEventId: string
): BotItemGroups {
  return groupBotsItems([{ items, staleDays, seenEventId }], now)
}

/** Several bots' items in one set of groups, a group's members' merged: each item grouped by its own
 *  bot's stale setting and marked changed by its own bot's seen mark, then ordered as one bot's are. */
export function groupBotsItems(
  bots: readonly { items: readonly BotItem[]; staleDays: number | null; seenEventId: string }[],
  now: number
): BotItemGroups {
  const groups: BotItemGroups = {
    needs_you: [],
    working: [],
    planned: [],
    snoozed: [],
    stale: [],
    closed: []
  }
  const unseenUids = new Set<string>()
  for (const { items, staleDays, seenEventId } of bots) {
    for (const item of items) {
      groups[botItemGroupOf(item, staleDays, now)].push(item)
      if (isBotItemUnseen(item, seenEventId)) {
        unseenUids.add(item.uid)
      }
    }
  }
  const unseen = (item: BotItem) => Number(unseenUids.has(item.uid))
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

/** Several bots' loaded Closed items as one list in time order, newest first. Each bot pages its own,
 *  so an item older than the loaded end of a bot with more pages waits: that bot's next page may hold
 *  newer ones. `more`: the bot has Closed pages not read yet; `endAt`: its loaded end's last activity,
 *  when known (else its oldest loaded item's). */
export function botItemsClosedInTimeOrder(
  bots: readonly { closed: readonly BotItem[]; more: boolean; endAt?: number | null }[]
): BotItem[] {
  const tails = bots.flatMap(({ closed, more, endAt }) =>
    !more
      ? []
      : endAt != null
        ? [endAt]
        : closed.length > 0
          ? [Math.min(...closed.map((item) => item.lastActivityAt))]
          : []
  )
  const cutoff = tails.length > 0 ? Math.max(...tails) : -Infinity
  return bots
    .flatMap(({ closed }) => closed)
    .filter((item) => item.lastActivityAt >= cutoff)
    .toSorted((a, b) => b.lastActivityAt - a.lastActivityAt || b.number - a.number)
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
