// The bot side of the inbox: which bots have items new to you, those items, and pending access requests.
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  readBotNeedsYouOthersLast,
  readBots,
  subscribeToBotChanges
} from '@/lib/bot-catalog-snapshot'
import type { HostAccessRequest } from '@/lib/bot-access-requests'
import { botRefKey } from '@/lib/bot-hosts'
import { readBotItemsSeen, subscribeBotItemsSeen } from '@/lib/bot-items-seen'
import { useBotItems } from '@/components/bots/items/use-bot-items'
import { useBotItemsSeenMark } from '@/components/bots/items/use-bot-items-seen-mark'
import type { Bot } from '../../../../../shared/bot-types'
import { parseBotItemEventId, type BotItem } from '../../../../../shared/bots/bot-items'
import { botItemGroupOf, botItemStaleDays } from '../../../../../shared/bots/bot-item-groups'
import { botHasNewNeedingYou, readActivityInboxBots, type ActivityInboxBot } from './activity-inbox'
import { useLiveAccessRequests } from './use-live-access-requests'

function subscribeToBotsAndSeen(listener: () => void): () => void {
  const unsubscribeBots = subscribeToBotChanges(listener)
  const unsubscribeSeen = subscribeBotItemsSeen(listener)
  return () => {
    unsubscribeBots()
    unsubscribeSeen()
  }
}

// A primitive key, so the external-store snapshot is stable between notifications.
function readBotsNeedingYouKey(): string {
  return readActivityInboxBots()
    .map(
      ({ bot, count }) => `${botRefKey(bot)}\u0000${count}\u0000${Number(botHasNewNeedingYou(bot))}`
    )
    .join('\u0001')
}

export type ActivityInboxBotSources = {
  /** Bots with something new to you in Needs you since Activity opened; only these have their items read. */
  bots: ActivityInboxBot[]
  requests: readonly HostAccessRequest[]
}

/** From what the renderer already holds (no fetch): the bots to read items for, and access requests. */
export function useActivityInboxBotSources(): ActivityInboxBotSources {
  const botsKey = useSyncExternalStore(subscribeToBotsAndSeen, readBotsNeedingYouKey)
  // The bot list's identity too, so a renamed bot or a changed itemsStale reaches the rows.
  const allBots = useSyncExternalStore(subscribeToBotChanges, readBots)
  // A bot stays read for this visit once it had something new, so opening one of its items (which marks the
  // bot's items seen) doesn't take the rest of its rows away while you're here.
  const shown = useRef(new Set<string>())
  const bots = useMemo(
    () =>
      readActivityInboxBots().filter(({ bot }) => {
        const key = botRefKey(bot)
        if (botHasNewNeedingYou(bot)) {
          shown.current.add(key)
        }
        return shown.current.has(key)
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- botsKey and allBots are what the read depends on.
    [botsKey, allBots]
  )
  return { bots, requests: useLiveAccessRequests() }
}

/**
 * A bot's items in Needs you, as its Items tab groups them, and the seen mark they're told against: the bot's as
 * this visit opened (rows you haven't opened stay while you're here), or null when its host is too old to keep
 * one (every item is a to-do). `items` is null until its list has been read.
 */
export type BotItemsNeedingYou = { bot: Bot; items: BotItem[] | null; seen: number | null }

/** Whether a listed item is new to you: someone else moved it after the mark. */
export function isNewToYou(item: BotItem, seen: number | null): boolean {
  return seen === null || (parseBotItemEventId(item.othersLastEventId) ?? 0) > seen
}

/**
 * Reads one bot's items while Activity is open, through the same shared read as its Items tab (one read per
 * bot, re-read on its notices), and reports those in Needs you. Renders nothing.
 */
export function ActivityInboxBotItemsReader({
  bot,
  onItems
}: {
  bot: Bot
  onItems: (key: string, value: BotItemsNeedingYou | undefined) => void
}): null {
  const { read, state, landed } = useBotItems(bot)
  const key = botRefKey(bot)
  // The list read's mark, held as this visit opened, so opening one item (which moves it) leaves the rest.
  const mark = useBotItemsSeenMark(bot, read, landed)
  // A host too old to say what is new to you lists every item as a to-do, as the dot reads it.
  const todo = useSyncExternalStore(
    subscribeToBotChanges,
    () => readBotNeedsYouOthersLast(bot) === null
  )
  useEffect(() => {
    // Grouped as the list lands (staleness reads the clock), not during render.
    const staleDays = botItemStaleDays(bot.itemsStale)
    const now = Date.now()
    // A read that failed with nothing kept settles as no rows, so the inbox never waits on it forever.
    const items = read
      ? read.items.filter((item) => botItemGroupOf(item, staleDays, now) === 'needs_you')
      : state === 'failed'
        ? []
        : null
    // Until this visit's read lands the mark is a kept list's, older than what you've seen since: the bot's own
    // (and this window's last move) is newer.
    const kept = parseBotItemEventId(mark ?? '') ?? 0
    const seen = todo ? null : landed ? kept : Math.max(kept, readBotItemsSeen(bot))
    onItems(key, { bot, items, seen })
  }, [key, bot, read, state, mark, landed, todo, onItems])
  useEffect(() => () => onItems(key, undefined), [key, onItems])
  return null
}
