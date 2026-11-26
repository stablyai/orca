// The bot side of the inbox: which bots have items for you, those items, and pending access requests.
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { readBots, readLiveBotHostIds, subscribeToBotChanges } from '@/lib/bot-catalog-snapshot'
import { useAccessRequests, type HostAccessRequest } from '@/lib/bot-access-requests'
import { botRefKey } from '@/lib/bot-hosts'
import { useBotItems } from '@/components/bots/items/use-bot-items'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { botItemGroupOf, botItemStaleDays } from '../../../../../shared/bots/bot-item-groups'
import { isLiveAccessRequest, readActivityInboxBots, type ActivityInboxBot } from './activity-inbox'

// A primitive key, so the external-store snapshot is stable between notifications.
function readBotsNeedingYouKey(): string {
  return readActivityInboxBots()
    .map(({ bot, count }) => `${bot.hostId}\u0000${bot.id}\u0000${count}`)
    .join('\u0001')
}

export type ActivityInboxBotSources = {
  /** Bots whose published count says items need you; only these have their items read. */
  bots: ActivityInboxBot[]
  requests: HostAccessRequest[]
}

/** From what the renderer already holds (no fetch): the bots to read items for, and access requests. */
export function useActivityInboxBotSources(): ActivityInboxBotSources {
  const botsKey = useSyncExternalStore(subscribeToBotChanges, readBotsNeedingYouKey)
  // The bot list's identity too, so a renamed bot or a changed itemsStale reaches the rows.
  const allBots = useSyncExternalStore(subscribeToBotChanges, readBots)
  const liveHosts = useSyncExternalStore(subscribeToBotChanges, readLiveBotHostIds)
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- botsKey and allBots are what the read depends on.
  const bots = useMemo(() => readActivityInboxBots(), [botsKey, allBots])
  const allRequests = useAccessRequests()
  const requests = useMemo(
    () => allRequests.filter((request) => isLiveAccessRequest(request)),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- liveHosts and allBots are what the filter reads.
    [allRequests, liveHosts, allBots]
  )
  return { bots, requests }
}

/** A bot's items in Needs you, as its Items tab groups them; null until its list has been read. */
export type BotItemsNeedingYou = { bot: Bot; items: BotItem[] | null }

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
  const { read, state } = useBotItems(bot)
  const key = botRefKey(bot)
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
    onItems(key, { bot, items })
  }, [key, bot, read, state, onItems])
  useEffect(() => () => onItems(key, undefined), [key, onItems])
  return null
}
