// What a bot host read reads next: the asks since its last read, and for a read that can read part of
// its value again (the Items list), the parts a notice named.
import type { BotChangeScope } from '../../../../shared/bots/bot-change-scope'

/** The asks waiting on the next read: none, only these parts, or the whole. */
export type BotReadAsk = Set<string> | 'whole' | null

/** One more ask joined to those waiting: its parts while every ask named some and they stay within
 *  `max`; otherwise the whole. */
export function addBotReadAsk(
  waiting: BotReadAsk,
  named: readonly string[] | null | undefined,
  max: number
): BotReadAsk {
  if (!named || waiting === 'whole') {
    return 'whole'
  }
  const next = waiting ?? new Set<string>()
  named.forEach((part) => next.add(part))
  return next.size > max ? 'whole' : next
}

/** The parts the next read may read alone; null when it reads whole. */
export function askedParts(waiting: BotReadAsk): string[] | null {
  return waiting instanceof Set && waiting.size > 0 ? [...waiting] : null
}

/** A read that can read part of its value again: the parts a notice names (a bot's changed items),
 *  merged into the last value. */
export type BotHostReadParts<T> = {
  /** The parts a notice names for the bot, or null when it must read whole. */
  of: (scope: BotChangeScope | undefined, botId: string) => readonly string[] | null
  /** The params that read just these parts. */
  params: (parts: readonly string[]) => Record<string, unknown>
  /** The last value with the parts' read merged in; `previous` itself when nothing changed. */
  merge: (previous: T, read: T, parts: readonly string[]) => T
  /** The most parts one read takes; more read whole. */
  max: number
}

export type BotHostReadOptions<T> = {
  /** Sent with every read. */
  params?: Record<string, unknown>
  parts?: BotHostReadParts<T>
}
