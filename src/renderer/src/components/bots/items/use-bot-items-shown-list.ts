// The Items list as the filter shows it: the bot's read (or one chat's), its Closed pages, filtered and
// grouped. Read above the list/item switch, so an open item walks the same list and Back finds it.
import { useMemo } from 'react'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import {
  botItemStaleDays,
  filterBotItems,
  groupBotItems,
  type BotItemFilter,
  type BotItemGroups
} from '../../../../../shared/bots/bot-item-groups'
import { mergeBotItemsByUid } from '../../../../../shared/bots/bot-item-merge'
import { useBotChatItems, type BotItemsRead } from './use-bot-items'
import { useBotItemsClosedPages, type BotItemsClosedPage } from './use-bot-items-closed-pages'

export type BotItemsShownList = {
  /** The bot's read, or the filtered chat's; null while that chat's first read is out. */
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
}

export function useBotItemsShownList(
  bot: Bot,
  botRead: BotItemsRead | null,
  filter: BotItemFilter,
  now: number,
  seenEventId: string
): BotItemsShownList {
  // One chat shown: its own read, so its counts and Closed pages are the chat's, not the first page's.
  const chatRead = useBotChatItems(bot, filter.chatId)
  const read = filter.chatId === null ? botRead : chatRead.read
  const closedPages = useBotItemsClosedPages(bot, read, filter.chatId)
  const items = useMemo(
    () => mergeBotItemsByUid(read?.items ?? [], closedPages.items),
    [read, closedPages.items]
  )
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
    loadMoreClosed: filter.needsYou ? null : closedPages.loadMore,
    closedEnded: filter.needsYou || closedPages.ended
  }
}
