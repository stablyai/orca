// What a bot host read reads next: the asks since its last read began. A read that can read part of
// its value again (the Items list) takes the parts a notice named, and a request for more (its next
// Closed page), and reads them in its own `load`, one read at a time.
import type { BotRef } from '@/lib/bot-hosts'
import type { BotChangeScope } from '../../../../shared/bots/bot-change-scope'

/** The asks waiting on the next read: none, only these parts, or the whole. */
export type BotReadAsk = Set<string> | 'whole' | null

/** One more ask joined to those waiting: its parts while every ask named some and they stay within
 *  `max`; otherwise the whole. An ask naming no parts changes nothing. */
export function addBotReadAsk(
  waiting: BotReadAsk,
  named: readonly string[] | null | undefined,
  max: number
): BotReadAsk {
  if (!named || waiting === 'whole') {
    return 'whole'
  }
  if (named.length === 0) {
    return waiting
  }
  const next = waiting ?? new Set<string>()
  named.forEach((part) => next.add(part))
  return next.size > max ? 'whole' : next
}

/** What one read covers: the whole value, or the named parts; and more of it. */
export type BotHostReadLoadAsk = { whole: boolean; parts: readonly string[]; more: boolean }

/** The ask a read covers, from the asks waiting and whether a good value is there to build on. */
export function botReadLoadAsk(
  waiting: BotReadAsk,
  more: boolean,
  hasGoodValue: boolean
): BotHostReadLoadAsk {
  const parts = waiting instanceof Set ? [...waiting] : []
  return { whole: !hasGoodValue || waiting === 'whole', parts, more }
}

/** A read that reads its value itself: the whole, the parts a notice named, or more of it. */
export type BotHostReadOptions<T> = {
  /** The parts a notice can have changed in the bot's value, or null when it must read whole. */
  partsOf: (
    scope: BotChangeScope | undefined,
    botId: string,
    value: T | null
  ) => readonly string[] | null
  /** The most parts one read takes; more read whole. */
  maxParts: number
  /** The value for this ask, built on `previous` (null for a first read); `show` puts up a value
   *  while the read goes on; `live` turns false once nothing will take it; `waiting` turns true once
   *  a newer ask waits on this read. */
  load: (
    bot: BotRef,
    previous: T | null,
    ask: BotHostReadLoadAsk,
    show: (value: T) => void,
    live: () => boolean,
    waiting: () => boolean
  ) => Promise<T>
}
