// Joining item reads: Closed pages onto the list, the changed items a notice named onto it, and newer
// Activity pages onto an open item's.
import { reuseEqualJson } from '../reuse-equal-json'
import { BOT_ITEM_LIMITS, type BotItem, type BotItemEvent } from './bot-items'
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

/** A list read with the named items read again, shaped as a whole read: each named one replaced,
 *  dropped when the read no longer has it (deleted), or added; every open item and, while more pages
 *  remain, the first page of Closed with its end moved to match. Every other item keeps its identity.
 *  `previous` itself when nothing changed. */
export function mergeNamedBotItems(
  previous: BotItemsListRead,
  named: BotItemsListRead,
  uids: readonly string[]
): BotItemsListRead {
  const asked = new Set(uids)
  const fresh = new Map(
    named.items.flatMap((item) => (asked.has(item.uid) ? [[item.uid, item] as const] : []))
  )
  const copies = new Map<string, BotItem | null>(uids.map((uid) => [uid, fresh.get(uid) ?? null]))
  let same = true
  const items = previous.items.flatMap((item) => {
    if (!asked.has(item.uid)) {
      return [item]
    }
    const next = fresh.get(item.uid)
    fresh.delete(item.uid)
    const kept = next ? reuseEqualJson(item, next) : null
    copies.set(item.uid, kept)
    same &&= kept === item
    return kept ? [kept] : []
  })
  // A Closed item new to the read joins it only above where its first page ends: one below belongs to
  // a later page (its copy reaches loaded pages through this step).
  const firstPageEnd = botItemCursorPlace(previous.nextClosedCursor)
  const added = [...fresh.values()].filter(
    (item) => !isClosedItem(item) || !firstPageEnd || botItemReaches(item, firstPageEnd)
  )
  const counts = reuseEqualJson(previous.counts, named.counts)
  // A named item this read didn't hold may sit in a loaded Closed page: its step still tells them.
  const elsewhere = uids.some((uid) => !previous.items.some((item) => item.uid === uid))
  if (same && added.length === 0 && counts === previous.counts && !elsewhere) {
    return previous.seenEventId === named.seenEventId
      ? previous
      : stepFrom(previous, copies, { ...previous, seenEventId: named.seenEventId })
  }
  // In the host's order (open, then Closed; each newest activity first), as a whole read has them.
  const ordered = [...items, ...added].sort(
    (a, b) =>
      Number(isClosedItem(a)) - Number(isClosedItem(b)) ||
      b.lastActivityAt - a.lastActivityAt ||
      b.number - a.number
  )
  const openCount = ordered.findIndex(isClosedItem)
  const closedFrom = openCount === -1 ? ordered.length : openCount
  // More pages remain: Closed keeps its first page, ending where the page now ends.
  const page = previous.nextClosedCursor
    ? ordered.slice(0, closedFrom + BOT_ITEM_LIMITS.listPage)
    : ordered
  const end = page.at(-1)
  const cursor =
    previous.nextClosedCursor && page.length < ordered.length && end
      ? { nextClosedCursor: `${end.lastActivityAt}:${end.number}` }
      : previous.nextClosedCursor
        ? { nextClosedCursor: previous.nextClosedCursor }
        : {}
  const { nextClosedCursor: _old, ...rest } = previous
  return stepFrom(previous, copies, {
    ...rest,
    items: page,
    counts,
    seenEventId: named.seenEventId,
    ...cursor
  })
}

/** A Closed cursor's place: `at:number` of the last row before it. */
export function botItemCursorPlace(
  cursor: string | null | undefined
): { at: number; number: number } | null {
  const [at, number] = (cursor ?? '').split(':').map(Number)
  return Number.isFinite(at) && Number.isFinite(number) ? { at: at!, number: number! } : null
}

/** At or above the place in Closed order (newest activity first, then highest number). */
export function botItemReaches(item: BotItem, place: { at: number; number: number }): boolean {
  return (
    item.lastActivityAt > place.at ||
    (item.lastActivityAt === place.at && item.number >= place.number)
  )
}

function isClosedItem(item: BotItem): boolean {
  return item.status === 'done' || item.status === 'canceled'
}

type NamedStep = {
  from: WeakRef<BotItemsListRead>
  /** Each named item's copy now; null for one the host no longer has. */
  copies: ReadonlyMap<string, BotItem | null>
}

/** Each merged read's step: the read it was merged into, held weakly so a chain of reads isn't kept. */
const steps = new WeakMap<BotItemsListRead, NamedStep>()

function stepFrom(
  previous: BotItemsListRead,
  copies: ReadonlyMap<string, BotItem | null>,
  next: BotItemsListRead
): BotItemsListRead {
  steps.set(next, { from: new WeakRef(previous), copies })
  return next
}

/** The named items read again between `from` and `read`, each with its newest copy (null: gone), when
 *  `read` is `from` with only named items merged in (over at most `limit` merges); null when it isn't,
 *  or the chain is no longer known. */
export function botItemsNamedSince(
  read: BotItemsListRead,
  from: BotItemsListRead,
  limit = 20
): Map<string, BotItem | null> | null {
  const copies = new Map<string, BotItem | null>()
  let at: BotItemsListRead | undefined = read
  for (let hop = 0; at && at !== from && hop < limit; hop++) {
    const step = steps.get(at)
    if (!step) {
      return null
    }
    // Walking back from the newest: the first copy seen is the newest.
    step.copies.forEach((copy, uid) => copies.has(uid) || copies.set(uid, copy))
    at = step.from.deref()
  }
  return at === from ? copies : null
}
