// Joining item reads: the changed items a notice named onto the list, and newer Activity pages onto an
// open item's.
import { reuseEqualJson } from '../reuse-equal-json'
import type { BotItemEvent } from './bot-items'
import type { BotItemsListRead } from './bot-item-schema'

/** Both lists in id order, each event once. */
export function mergeBotItemEvents(
  first: readonly BotItemEvent[],
  second: readonly BotItemEvent[]
): BotItemEvent[] {
  const seen = new Set(first.map((event) => event.id))
  return [...first, ...second.filter((event) => !seen.has(event.id))]
}

/** A list read with the named items read again: each named one replaced, or dropped when the read no
 *  longer has it (deleted); a new one added; every other item keeps its identity. `previous` itself
 *  when nothing changed. */
export function mergeNamedBotItems(
  previous: BotItemsListRead,
  named: BotItemsListRead,
  uids: readonly string[]
): BotItemsListRead {
  const asked = new Set(uids)
  const fresh = new Map(named.items.map((item) => [item.uid, item]))
  let same = true
  const items = previous.items.flatMap((item) => {
    if (!asked.has(item.uid)) {
      return [item]
    }
    const next = fresh.get(item.uid)
    fresh.delete(item.uid)
    const kept = next ? reuseEqualJson(item, next) : null
    same &&= kept === item
    return kept ? [kept] : []
  })
  const added = [...fresh.values()].filter((item) => asked.has(item.uid))
  const counts = reuseEqualJson(previous.counts, named.counts)
  if (same && added.length === 0 && counts === previous.counts) {
    return previous.seenEventId === named.seenEventId
      ? previous
      : { ...previous, seenEventId: named.seenEventId }
  }
  return { ...previous, items: [...items, ...added], counts, seenEventId: named.seenEventId }
}
