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

/** How many Closed items a list read holds: the depth its owner has loaded. */
export function botItemsClosedLoaded(read: BotItemsListRead): number {
  return read.items.filter(isClosedItem).length
}

/** The Closed rows a read keeps room for: those loaded (a page at least), or for a read to its end
 *  the pages it took, as many as reading each loaded page again would hold. */
export function botItemsClosedDepth(read: BotItemsListRead): number {
  const page = BOT_ITEM_LIMITS.listPage
  const loaded = botItemsClosedLoaded(read)
  return Math.max(page, read.nextClosedCursor ? loaded : Math.ceil(loaded / page) * page)
}

/** A list read with the named items read again, shaped as a whole read of the same depth: each named
 *  one replaced, dropped when the read no longer has it (deleted), or added; every open item and the
 *  loaded Closed depth, its end moved to match. Every other item keeps its identity. `previous` itself
 *  when nothing changed. */
export function mergeNamedBotItems(
  previous: BotItemsListRead,
  named: BotItemsListRead,
  uids: readonly string[]
): BotItemsListRead {
  const asked = new Set(uids)
  const fresh = new Map(
    named.items.flatMap((item) => (asked.has(item.uid) ? [[item.uid, item] as const] : []))
  )
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
  // A Closed item stays in or joins the read only above where its loaded Closed ends: one below (new
  // to it, or moved down by a host clock set back) is on a page not loaded yet, which reads it then.
  const loadedEnd = botItemCursorPlace(previous.nextClosedCursor)
  const loaded = (item: BotItem) =>
    !isClosedItem(item) || !loadedEnd || botItemReaches(item, loadedEnd)
  const added = [...fresh.values()].filter(loaded)
  same &&= items.every(loaded)
  const counts = reuseEqualJson(previous.counts, named.counts)
  if (same && added.length === 0 && counts === previous.counts) {
    return previous.seenEventId === named.seenEventId
      ? previous
      : { ...previous, seenEventId: named.seenEventId }
  }
  // In the host's order (open, then Closed; each newest activity first), as a whole read has them.
  const ordered = [...items.filter(loaded), ...added].sort(
    (a, b) =>
      Number(isClosedItem(a)) - Number(isClosedItem(b)) ||
      b.lastActivityAt - a.lastActivityAt ||
      b.number - a.number
  )
  // No deeper than it was loaded: rows pushed past the end wait behind Show more.
  const depth = botItemsClosedDepth(previous)
  const firstClosed = ordered.findIndex(isClosedItem)
  const keep = (firstClosed === -1 ? ordered.length : firstClosed) + depth
  const page = ordered.slice(0, keep)
  const end = page.at(-1)
  const cursor =
    page.length < ordered.length && end
      ? `${end.lastActivityAt}:${end.number}`
      : previous.nextClosedCursor
  const { nextClosedCursor: _old, ...rest } = previous
  return {
    ...rest,
    items: page,
    counts,
    seenEventId: named.seenEventId,
    ...(cursor ? { nextClosedCursor: cursor } : {})
  }
}

/** A list read with the next Closed page read after it: the page's Closed items appended (a copy it
 *  already held replaced by the page's newer one), and its end moved to the page's. */
export function appendBotItemsClosedPage(
  previous: BotItemsListRead,
  page: BotItemsListRead
): BotItemsListRead {
  const fresh = new Map(
    page.items.flatMap((item) => (isClosedItem(item) ? [[item.uid, item] as const] : []))
  )
  const items = previous.items.map((item) => {
    const next = fresh.get(item.uid)
    fresh.delete(item.uid)
    return next ? reuseEqualJson(item, next) : item
  })
  const { nextClosedCursor: _old, ...rest } = previous
  return {
    ...rest,
    items: [...items, ...fresh.values()],
    counts: reuseEqualJson(previous.counts, page.counts),
    ...(page.nextClosedCursor ? { nextClosedCursor: page.nextClosedCursor } : {})
  }
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
