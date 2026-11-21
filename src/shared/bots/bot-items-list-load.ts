// One read of an Items list (a bot's, or some chats'), building on the last: the whole list at the
// Closed depth its owner has loaded, the items a notice named merged in, and the next Closed page
// appended. Reads of one list run one at a time, so these never race over its value.
import { BOT_ITEM_LIMITS } from './bot-items'
import type { BotItemsListRead } from './bot-item-schema'
import {
  appendBotItemsClosedPage,
  botItemCursorPlace,
  botItemReaches,
  botItemsClosedLoaded,
  mergeNamedBotItems
} from './bot-item-merge'
import { reuseEqualJson } from '../reuse-equal-json'

/** One `bots.items.owner.list` call with these params (the bot, its chats and `summary` added). */
export type BotItemsListCall = (params: Record<string, unknown>) => Promise<BotItemsListRead>

export type BotItemsListAsk = { whole: boolean; parts: readonly string[]; more: boolean }

/** `show`: a value to show while the read goes on (a host before `closedLimit` pages down the
 *  depth): its first page, with the rows loaded before it below that page kept until theirs land. */
export async function loadBotItemsList(
  call: BotItemsListCall,
  previous: BotItemsListRead | null,
  ask: BotItemsListAsk,
  show?: (value: BotItemsListRead) => void
): Promise<BotItemsListRead> {
  const page = BOT_ITEM_LIMITS.listPage
  if (!ask.whole && previous && ask.parts.length > 0) {
    const asked = new Set(ask.parts)
    const named = await call({ uids: ask.parts })
    // A Closed cursor or an item not asked for is a host before `uids` answering whole: what it left
    // out isn't gone, so the list is read whole.
    if (named.nextClosedCursor || named.items.some((item) => !asked.has(item.uid))) {
      return loadBotItemsList(call, previous, { ...ask, whole: true }, show)
    }
    const merged = mergeNamedBotItems(previous, named, ask.parts)
    return ask.more
      ? loadBotItemsList(call, merged, { whole: false, parts: [], more: true })
      : merged
  }
  if (ask.whole || !previous) {
    // The depth loaded so far, a page more when asked: in one read, or page by page from a host
    // before `closedLimit` (it answers one page).
    const loaded = previous ? botItemsClosedLoaded(previous) : 0
    const more = ask.more && previous?.nextClosedCursor ? page : 0
    const want = Math.max(page, loaded) + more
    let value = await call({ closedLimit: Math.min(want, BOT_ITEM_LIMITS.closedLoadMax) })
    // A host before `closedLimit` answered one page: when that page is as loaded, so are the pages
    // after it, as before this read (no more asked).
    if (previous && !more && value.nextClosedCursor && botItemsClosedLoaded(value) < want) {
      if (sameFirstPage(previous, value)) {
        return previous
      }
    }
    if (show && previous && value.nextClosedCursor && botItemsClosedLoaded(value) < want) {
      show(reuseEqualJson(previous, withLoadedBelow(value, previous)))
    }
    while (value.nextClosedCursor && botItemsClosedLoaded(value) < want) {
      const rest = want - botItemsClosedLoaded(value)
      value = appendBotItemsClosedPage(
        value,
        await call({
          closedCursor: value.nextClosedCursor,
          closedOnly: true,
          closedLimit: Math.min(rest, BOT_ITEM_LIMITS.closedLoadMax)
        })
      )
    }
    return reuseEqualJson(previous, value)
  }
  let value = previous
  if (ask.more && value.nextClosedCursor) {
    value = appendBotItemsClosedPage(
      value,
      await call({ closedCursor: value.nextClosedCursor, closedOnly: true })
    )
  }
  return value
}

/** `first` with `previous`'s Closed rows below its end, to show until the rest of the depth lands. */
function withLoadedBelow(first: BotItemsListRead, previous: BotItemsListRead): BotItemsListRead {
  const end = botItemCursorPlace(first.nextClosedCursor)
  const held = new Set(first.items.map((item) => item.uid))
  const below = previous.items.filter(
    (item) =>
      (item.status === 'done' || item.status === 'canceled') &&
      !held.has(item.uid) &&
      end !== null &&
      !botItemReaches(item, end)
  )
  return {
    ...first,
    items: [...first.items, ...below],
    ...(previous.nextClosedCursor ? { nextClosedCursor: previous.nextClosedCursor } : {})
  }
}

/** Whether `first` (a host's one-page answer) holds just what `previous` holds down to that page's end. */
function sameFirstPage(previous: BotItemsListRead, first: BotItemsListRead): boolean {
  const isClosed = (item: { status: string }) =>
    item.status === 'done' || item.status === 'canceled'
  const closedCount = botItemsClosedLoaded(first)
  const open = previous.items.filter((item) => !isClosed(item))
  const head = [...open, ...previous.items.filter(isClosed).slice(0, closedCount)]
  return (
    reuseEqualJson(head, first.items) === head &&
    reuseEqualJson(previous.counts, first.counts) === previous.counts &&
    previous.seenEventId === first.seenEventId
  )
}
