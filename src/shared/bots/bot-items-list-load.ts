// One read of an Items list (a bot's, or some chats'), building on the last: the whole list at the
// Closed depth its owner has loaded, the items a notice named merged in, and the next Closed page
// appended. Reads of one list run one at a time, so these never race over its value.
import { BOT_ITEM_LIMITS, type BotItem } from './bot-items'
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
import { BOT_ITEMS_WORKER_LINKED } from './bot-items-notice-parts'

/** One `bots.items.owner.list` call with these params (the bot, its chats and `summary` added). */
export type BotItemsListCall = (params: Record<string, unknown>) => Promise<BotItemsListRead>

export type BotItemsListAsk = { whole: boolean; parts: readonly string[]; more: boolean }

export type BotItemsListLoadOptions = {
  /** A value to show while the read goes on: a whole read's fresh first page, with the rows loaded
   *  before it below that page kept until theirs land (or dropped, if a page below fails). */
  show?: (value: BotItemsListRead) => void
  /** False once nothing will show the value, so no further call is made for it. */
  live?: () => boolean
  /** A whole read pages down the loaded depth every time, not only once its first page moves (the
   *  chat-filtered list always read its loaded pages again). */
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
  const parts = previous ? namedParts(ask.parts, previous) : []
  if (!ask.whole && previous && parts.length > 0) {
    const named = await readNamed(call, parts, live)
    // A host before `uids` answers whole: what it left out isn't gone, so the list is read whole.
    if (!named) {
      return live() ? loadBotItemsList(call, previous, { ...ask, whole: true }, options) : previous
    }
    const merged = mergeNamedBotItems(previous, named, parts)
    if (!ask.more || !live()) {
      return merged
    }
    // A failed page fails only Show more: the named items stand.
    return loadBotItemsList(call, merged, { whole: false, parts: [], more: true }, options).catch(
      () => merged
    )
  }
  if (ask.whole || !previous) {
    // The depth loaded so far, a page more when asked, a page per call: no answer is larger than one
    // page read alone (a paired connection caps an answer's size).
    const more = ask.more && previous?.nextClosedCursor ? page : 0
    const want = (previous ? botItemsClosedDepth(previous) : page) + more
    const first = await call({})
    // When the first page is as loaded, the pages below it are read again only once it moves (as
    // before): the next page is all that more asks.
    if (previous && !options.pageUnmoved && sameFirstPage(previous, first)) {
      return more && live()
        ? loadBotItemsList(call, previous, { whole: false, parts: [], more: true }, options)
        : previous
    }
    if (show && previous && first.nextClosedCursor && botItemsClosedLoaded(first) < want) {
      show(reuseEqualJson(previous, withLoadedBelow(first, previous)))
    }
    // The pages below, gathered and joined to the first page once.
    const below: BotItem[] = []
    let loaded = botItemsClosedLoaded(first)
    let last: BotItemsListRead = first
    while (live() && last.nextClosedCursor && loaded < want) {
      try {
        last = await call({
          closedCursor: last.nextClosedCursor,
          closedOnly: true,
          closedLimit: Math.min(want - loaded, page)
        })
      } catch {
        // The first page is fresh; the pages below it load again through Show more (as before).
        return reuseEqualJson(previous, first)
      }
      const closedRows = last.items.filter(isClosedRow)
      below.push(...closedRows)
      loaded += closedRows.length
    }
    const value =
      last === first ? first : appendBotItemsClosedPage(first, { ...last, items: below })
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

/** The named items, a read per `listPageMax` of them; null when a host before `uids` answered whole
 *  (a Closed cursor, or an item not asked for) or nothing will take them. Counts are the last read's;
 *  the seen mark the first's, which every row read after it is at least as new as. */
async function readNamed(
  call: BotItemsListCall,
  uids: readonly string[],
  live: () => boolean
): Promise<BotItemsListRead | null> {
  let first: BotItemsListRead | null = null
  const items: BotItem[] = []
  let counts: BotItemsListRead['counts'] = {}
  for (let at = 0; at < uids.length; at += BOT_ITEM_LIMITS.listPageMax) {
    if (first && !live()) {
      return null
    }
    const batch = uids.slice(at, at + BOT_ITEM_LIMITS.listPageMax)
    const asked = new Set(batch)
    const answer: BotItemsListRead = await call({ uids: batch })
    if (answer.nextClosedCursor || answer.items.some((item) => !asked.has(item.uid))) {
      return null
    }
    first ??= answer
    items.push(...answer.items)
    counts = answer.counts
  }
  return first && { ...first, items, counts }
}

/** The uids the parts name, the worker-linked part as the loaded items that link a worker now. */
function namedParts(parts: readonly string[], previous: BotItemsListRead): string[] {
  const uids = new Set(parts.filter((part) => part !== BOT_ITEMS_WORKER_LINKED))
  if (parts.includes(BOT_ITEMS_WORKER_LINKED)) {
    for (const item of previous.items) {
      if (item.links.some((link) => link.kind === 'dispatch')) {
        uids.add(item.uid)
      }
    }
  }
  return [...uids]
}

/** `first` with `previous`'s Closed rows below its end, to show until the rest of the depth lands. */
function withLoadedBelow(first: BotItemsListRead, previous: BotItemsListRead): BotItemsListRead {
  const end = botItemCursorPlace(first.nextClosedCursor)
  const held = new Set(first.items.map((item) => item.uid))
  const below = previous.items.filter(
    (item) => isClosedRow(item) && !held.has(item.uid) && end !== null && !botItemReaches(item, end)
  )
  return {
    ...first,
    items: [...first.items, ...below],
    ...(previous.nextClosedCursor ? { nextClosedCursor: previous.nextClosedCursor } : {})
  }
}

function isClosedRow(item: { status: string }): boolean {
  return item.status === 'done' || item.status === 'canceled'
}

/** Whether `first` (a host's one-page answer) holds just what `previous` holds down to that page's end. */
function sameFirstPage(previous: BotItemsListRead, first: BotItemsListRead): boolean {
  const closedCount = botItemsClosedLoaded(first)
  const open = previous.items.filter((item) => !isClosedRow(item))
  const head = [...open, ...previous.items.filter(isClosedRow).slice(0, closedCount)]
  return (
    reuseEqualJson(head, first.items) === head &&
    reuseEqualJson(previous.counts, first.counts) === previous.counts &&
    previous.seenEventId === first.seenEventId
  )
}
