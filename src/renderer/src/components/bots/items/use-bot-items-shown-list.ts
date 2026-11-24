// The Items list as the filter shows it: the bot's read (or one chat's), Closed as deep as loaded,
// filtered and grouped. Read above the list/item switch, so an open item walks the same list and Back finds it.
import { translate } from '@/i18n/i18n'
import { useCallback, useMemo } from 'react'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import {
  botItemStaleDays,
  filterBotItems,
  groupBotItems,
  type BotItemFilter,
  type BotItemGroups
} from '../../../../../shared/bots/bot-item-groups'
import { botItemCursorPlace, botItemReaches } from '../../../../../shared/bots/bot-item-merge'
import { readMoreBotItems, useBotChatItems, type BotItemsRead } from './use-bot-items'

/** One Show more: the Closed items it loaded, and whether more remain. */
export type BotItemsClosedPage = { items: readonly BotItem[]; more: boolean }

const NONE: readonly BotItem[] = []

const isClosed = (item: BotItem): boolean => item.status === 'done' || item.status === 'canceled'

export type BotItemsShownList = {
  /** The bot's read, or the filtered chats'; null while that chat's first read is out. */
  read: BotItemsRead | null
  chatRead: ReturnType<typeof useBotChatItems>
  /** Every loaded item, before the filter. */
  items: readonly BotItem[]
  shown: readonly BotItem[]
  groups: BotItemGroups
  staleDays: number | null
  /** Closed items in this list on the host, loaded or not. */
  closedTotal: number
  /** Reads the next Closed page; null when there is none or Closed isn't in this list. */
  loadMoreClosed: (() => Promise<BotItemsClosedPage>) | null
  /** Every Closed item this list counts is loaded. */
  closedEnded: boolean
  /** The last activity of the loaded Closed end, while more pages remain. */
  closedEndAt?: number | null
}

export function useBotItemsShownList(
  bot: Bot,
  botRead: BotItemsRead | null,
  filter: BotItemFilter,
  now: number,
  seenEventId: string
): BotItemsShownList {
  // Some chats shown: their own read, so counts and Closed pages are theirs, not the first page's.
  const chatRead = useBotChatItems(bot, filter.chatIds)
  const read = filter.chatIds === null ? botRead : chatRead.read
  // Closed loads as deep as asked inside the read itself: Show more is one more read of it, in turn.
  const items = read?.items ?? NONE
  const cursor = read?.nextClosedCursor ?? null
  const { hostId, id } = bot
  const chatMore = chatRead.readMore
  const filtered = filter.chatIds !== null
  const loadMore = useCallback(async (): Promise<BotItemsClosedPage> => {
    const before = new Set(items.map((item) => item.uid))
    const end = botItemCursorPlace(cursor)
    const after = await (filtered ? chatMore() : readMoreBotItems({ hostId, id }))
    if (!after) {
      throw new Error(
        translate('bots.items.readMoreClosedFailed', 'Reading more Closed items failed')
      )
    }
    // The page: rows below the old end. One closed meanwhile lands at the top, not in the page.
    return {
      items: after.items.filter(
        (item) => isClosed(item) && !before.has(item.uid) && (!end || !botItemReaches(item, end))
      ),
      more: Boolean(after.nextClosedCursor)
    }
  }, [items, filtered, chatMore, hostId, id, cursor])
  const staleDays = botItemStaleDays(bot.itemsStale)
  const shown = useMemo(() => filterBotItems(items, filter), [items, filter])
  const groups = useMemo(
    () => groupBotItems(shown, staleDays, now, seenEventId),
    [shown, staleDays, now, seenEventId]
  )
  return {
    read,
    chatRead,
    items,
    shown,
    groups,
    staleDays,
    closedTotal:
      filter.needsYou || !read
        ? groups.closed.length
        : (read.counts.done ?? 0) + (read.counts.canceled ?? 0),
    loadMoreClosed: filter.needsYou || !cursor ? null : loadMore,
    closedEnded: filter.needsYou || (read !== null && !cursor),
    closedEndAt: filter.needsYou ? null : (botItemCursorPlace(cursor)?.at ?? null)
  }
}
