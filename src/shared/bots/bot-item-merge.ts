// Joining item reads: Closed pages onto the list, the changed items a notice named onto it, and newer
// Activity pages onto an open item's.
import { reuseEqualJson } from '../reuse-equal-json'
import type { BotItem, BotItemEvent } from './bot-items'
import type { BotItemsListRead } from './bot-item-schema'

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
      : stepFrom(previous, uids, { ...previous, seenEventId: named.seenEventId })
  }
  // In the host's order (open, then Closed; each newest activity first), as a whole read has them.
  const ordered = [...items, ...added].sort(
    (a, b) =>
      Number(isClosedItem(a)) - Number(isClosedItem(b)) ||
      b.lastActivityAt - a.lastActivityAt ||
      b.number - a.number
  )
  return stepFrom(previous, uids, {
    ...previous,
    items: ordered,
    counts,
    seenEventId: named.seenEventId
  })
}

function isClosedItem(item: BotItem): boolean {
  return item.status === 'done' || item.status === 'canceled'
}

/** Each merged read's step: the read it was merged into, held weakly so a chain of reads isn't kept. */
const steps = new WeakMap<
  BotItemsListRead,
  { from: WeakRef<BotItemsListRead>; uids: readonly string[] }
>()

function stepFrom(
  previous: BotItemsListRead,
  uids: readonly string[],
  next: BotItemsListRead
): BotItemsListRead {
  steps.set(next, { from: new WeakRef(previous), uids })
  return next
}

/** The items read again between `from` and `read` when `read` is `from` with only named items merged
 *  in (over at most `limit` merges); null when it isn't, or the chain is no longer known. */
export function botItemsNamedSince(
  read: BotItemsListRead,
  from: BotItemsListRead,
  limit = 20
): Set<string> | null {
  const uids = new Set<string>()
  let at: BotItemsListRead | undefined = read
  for (let hop = 0; at && at !== from && hop < limit; hop++) {
    const step = steps.get(at)
    if (!step) {
      return null
    }
    step.uids.forEach((uid) => uids.add(uid))
    at = step.from.deref()
  }
  return at === from ? uids : null
}
