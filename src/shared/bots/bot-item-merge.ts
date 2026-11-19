// Joining item reads: Closed pages onto the list, and newer Activity pages onto an open item's.
import type { BotItem, BotItemEvent } from './bot-items'

/** Each item once: a later read's copy (a reopened item) over a loaded page's. */
export function mergeBotItemsByUid(
  first: readonly BotItem[],
  second: readonly BotItem[]
): BotItem[] {
  const seen = new Set(first.map((item) => item.uid))
  return [...first, ...second.filter((item) => !seen.has(item.uid))]
}

/** Both lists in id order, each event once. */
export function mergeBotItemEvents(
  first: readonly BotItemEvent[],
  second: readonly BotItemEvent[]
): BotItemEvent[] {
  const seen = new Set(first.map((event) => event.id))
  return [...first, ...second.filter((event) => !seen.has(event.id))]
}
