// One read of an Items list (a bot's, or some chats'), building on the last: the whole list at the
// Closed depth its owner has loaded, the items a notice named merged in, and the next Closed page
// appended. Reads of one list run one at a time, so these never race over its value.
import { BOT_ITEM_LIMITS } from './bot-items'
import type { BotItemsListRead } from './bot-item-schema'
import {
  appendBotItemsClosedPage,
  botItemCursorPlace,
  botItemReaches,
  botItemsClosedDepth,
  botItemsClosedLoaded,
  mergeNamedBotItems
} from './bot-item-merge'
import { reuseEqualJson } from '../reuse-equal-json'

/** One `bots.items.owner.list` call with these params (the bot, its chats and `summary` added). */
export type BotItemsListCall = (params: Record<string, unknown>) => Promise<BotItemsListRead>

export type BotItemsListAsk = { whole: boolean; parts: readonly string[]; more: boolean }

export type BotItemsListLoadOptions = {
  /** A value to show while the read goes on (a host before `closedLimit` pages down the depth): its
   *  first page, with the rows loaded before it below that page kept until theirs land. */
  show?: (value: BotItemsListRead) => void
  /** False once nothing will show the value, so no further call is made for it. */
  live?: () => boolean
  /** A host before `closedLimit` is paged down on every whole read, not only once its first page
   *  moves (the chat-filtered list always read its loaded pages again). */
  pageUnmoved?: boolean
}

export async function loadBotItemsList(
  call: BotItemsListCall,
  previous: BotItemsListRead | null,
  ask: BotItemsListAsk,
  options: BotItemsListLoadOptions = {}
): Promise<BotItemsListRead> {
  const { show, live = () => true } = options
  const page = BOT_ITEM_LIMITS.listPage
  if (!ask.whole && previous && ask.parts.length > 0) {
    const asked = new Set(ask.parts)
    const named = await call({ uids: ask.parts })
    // A Closed cursor or an item not asked for is a host before `uids` answering whole: what it left
    // out isn't gone, so the list is read whole.
    if (named.nextClosedCursor || named.items.some((item) => !asked.has(item.uid))) {
      return live() ? loadBotItemsList(call, previous, { ...ask, whole: true }, options) : previous
    }
    const merged = mergeNamedBotItems(previous, named, ask.parts)
    return ask.more && live()
      ? loadBotItemsList(call, merged, { whole: false, parts: [], more: true }, options)
      : merged
  }
  if (ask.whole || !previous) {
    // The depth loaded so far, a page more when asked: in one read, or page by page from a host
    // before `closedLimit` (it answers one page).
    const more = ask.more && previous?.nextClosedCursor ? page : 0
    const want = (previous ? botItemsClosedDepth(previous) : page) + more
    const limit = Math.min(want, BOT_ITEM_LIMITS.closedLoadMax)
    let value = await call({ closedLimit: limit })
    // Fewer than asked with more left: a host before `closedLimit` answered one page. When that page
    // is as loaded, the pages below it are read again only once it moves (as before): the next page
    // is all that more asks.
    const older = Boolean(value.nextClosedCursor) && botItemsClosedLoaded(value) < limit
    if (previous && older && !options.pageUnmoved && sameFirstPage(previous, value)) {
      return more && live()
        ? loadBotItemsList(call, previous, { whole: false, parts: [], more: true }, options)
        : previous
    }
    if (show && previous && value.nextClosedCursor && botItemsClosedLoaded(value) < want) {
      show(reuseEqualJson(previous, withLoadedBelow(value, previous)))
    }
    while (live() && value.nextClosedCursor && botItemsClosedLoaded(value) < want) {
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
