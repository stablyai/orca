// Every listed host's bots with Needs you items, from the hosts' last bot list reads (their counts), so
// the inbox's button reads no items and the inbox reads only the bots that have some.
import { useSyncExternalStore } from 'react'
import type { Bot } from '../../../shared/bot-types'
import { useBots } from './bot-catalog'
import { readBotItemsNeedingOwner, readBots, subscribeToBotChanges } from './bot-catalog-snapshot'

export type BotsNeedingOwner = {
  /** Bots with Needs you items, or whose host doesn't count them (it may have some). */
  bots: readonly Bot[]
  /** Their Needs you items, as the hosts count them. */
  total: number
}

const NONE: BotsNeedingOwner = { bots: [], total: 0 }
let last: { source: readonly Bot[]; key: string; value: BotsNeedingOwner } | null = null

/** The same value on every read while the bots and their counts are unchanged. */
export function readBotsNeedingOwner(): BotsNeedingOwner {
  const source = readBots()
  const counted = source.flatMap((bot) => {
    const count = readBotItemsNeedingOwner(bot)
    return count === 0 ? [] : [{ bot, count }]
  })
  if (counted.length === 0) {
    return NONE
  }
  // Each read returns the same value while the bots and their counts are unchanged.
  const key = counted
    .map(({ bot, count }) => `${bot.hostId}\0${bot.id}\0${count ?? '?'}`)
    .join('\n')
  if (last?.source !== source || last.key !== key) {
    last = {
      source,
      key,
      value: {
        bots: counted.map(({ bot }) => bot),
        total: counted.reduce((sum, { count }) => sum + (count ?? 0), 0)
      }
    }
  }
  return last.value
}

export function useBotsNeedingOwner(): BotsNeedingOwner {
  // Starts the bot list's reads, as every bot surface does.
  useBots()
  return useSyncExternalStore(subscribeToBotChanges, readBotsNeedingOwner, readBotsNeedingOwner)
}
