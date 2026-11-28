// The newest item event each bot's owner has seen: the host's `itemsSeen` (one mark per bot, shared with a
// paired phone), raised at once by this window's own marks so the Activity dot clears before the bot list
// re-reads. Every value here came from a host's reply, and a read takes the higher of the two, so it never
// drifts from the host's.
import type { Bot } from '../../../shared/bot-types'
import { parseBotItemEventId } from '../../../shared/bots/bot-items'
import { botRefKey, callBotRpc, type BotRef } from './bot-hosts'

// Bounded: a mark matters only until the bot list's next read carries it.
const MAX_MARKS = 50

const marks = new Map<string, number>()
const listeners = new Set<() => void>()

export function subscribeBotItemsSeen(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The bot's seen mark, as an event id number; 0 before anything was seen. */
export function readBotItemsSeen(bot: Pick<Bot, 'id' | 'hostId' | 'itemsSeen'>): number {
  return Math.max(bot.itemsSeen ?? 0, marks.get(botRefKey(bot)) ?? 0)
}

/** Takes a host's reply that the bot's mark moved (`e41`); a lower one changes nothing. */
export function noteBotItemsSeen(bot: BotRef, seenEventId: string): void {
  const seen = parseBotItemEventId(seenEventId)
  const key = botRefKey(bot)
  if (seen === null || seen <= (marks.get(key) ?? 0)) {
    return
  }
  marks.delete(key)
  marks.set(key, seen)
  const oldest = marks.size > MAX_MARKS ? marks.keys().next().value : undefined
  if (oldest !== undefined) {
    marks.delete(oldest)
  }
  listeners.forEach((listener) => listener())
}

/** Marks everything the bot's items hold now as seen, as opening its Items tab does. */
export function markBotItemsSeen(bot: BotRef): Promise<void> {
  return callBotRpc<{ seenEventId?: string }>(bot, 'bots.items.owner.opened', { botId: bot.id })
    .then((result) => {
      if (result?.seenEventId) {
        noteBotItemsSeen(bot, result.seenEventId)
      }
    })
    .catch((error: unknown) => console.warn('[bots] items: marking them seen failed', error))
}

export function resetBotItemsSeenForTest(): void {
  marks.clear()
  listeners.clear()
}
