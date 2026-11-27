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
import { BotReadMoreFailed } from './bot-read-more-failed'

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
  /** True once a newer ask waits: paging down the loaded depth stops after the page in hand, and the
   *  next read takes it up from there. */
  waiting?: () => boolean
}

/** A value whose loaded depth was read again only down to this Closed cursor; the rows below it are
 *  the last read's, kept until the next read pages them. */
const unread = new WeakMap<BotItemsListRead, string>()

export async function loadBotItemsList(
  call: BotItemsListCall,
  previous: BotItemsListRead | null,
  ask: BotItemsListAsk,
  options: BotItemsListLoadOptions = {}
): Promise<BotItemsListRead> {
  const from = previous && !ask.whole ? unread.get(previous) : undefined
  // Named reads beyond a whole read's calls (one per loaded page) read every loaded page instead:
  // each call costs the host a read of its workers, however few rows it answers.
  if (previous && !ask.whole && namedCostsMore(previous, ask.parts, from)) {
    return loadAsked(call, previous, { ...ask, whole: true }, { ...options, pageUnmoved: true })
  }
  if (!from) {
    return loadAsked(call, previous, ask, options)
  }
  const value = await loadAsked(call, previous, { ...ask, more: false }, options)
  return readOwedThenMore(call, value, from, ask.more, options)
}

/** A read that stopped for a newer ask goes on below where it stopped (`from`) once that ask is in,
 *  then reads the next page when more is asked. */
async function readOwedThenMore(
  call: BotItemsListCall,
  value: BotItemsListRead,
  from: string,
  more: boolean,
  options: BotItemsListLoadOptions
): Promise<BotItemsListRead> {
  if (!isLive(options)) {
    return value
  }
  options.show?.(value)
  // From where it stopped, or from the list's end when a named read since moved that above it.
  const end = value.nextClosedCursor
  const start = end && cursorAbove(end, from) ? end : from
  const place = botItemCursorPlace(start)
  const top: BotItemsListRead = {
    ...value,
    items: value.items.filter(
      (item) => !isClosedRow(item) || (place !== null && botItemReaches(item, place))
    ),
    nextClosedCursor: start
  }
  const read = await readBelow(call, top, value, botItemsClosedDepth(value), options, false, start)
  if (!more || !isLive(options)) {
    return read
  }
  const owed = unread.get(read)
  const deeper = await loadAsked(
    call,
    read,
    { whole: false, parts: [], more: true },
    options
  ).catch(() => {
    throw new BotReadMoreFailed(read)
  })
  if (owed) {
    unread.set(deeper, owed)
  }
  return deeper
}

/** Whether reading the named items, and the pages still owed below `from`, takes more calls than
 *  reading every loaded page. */
function namedCostsMore(
  previous: BotItemsListRead,
  parts: readonly string[],
  from: string | undefined
): boolean {
  const page = BOT_ITEM_LIMITS.listPage
  const named = namedParts(parts, previous).length
  if (named === 0) {
    return false
  }
  const place = from ? botItemCursorPlace(from) : null
  const owed = place
    ? previous.items.filter((item) => isClosedRow(item) && !botItemReaches(item, place)).length
    : 0
  const wholeCalls = Math.ceil(botItemsClosedDepth(previous) / page)
  return Math.ceil(named / page) + Math.ceil(owed / page) > wholeCalls
}

/** Whether cursor `a` ends Closed above (before) cursor `b`. */
function cursorAbove(a: string, b: string): boolean {
  const pa = botItemCursorPlace(a)
  const pb = botItemCursorPlace(b)
  return Boolean(pa && pb && (pa.at > pb.at || (pa.at === pb.at && pa.number > pb.number)))
}

async function loadAsked(
  call: BotItemsListCall,
  previous: BotItemsListRead | null,
  ask: BotItemsListAsk,
  options: BotItemsListLoadOptions
): Promise<BotItemsListRead> {
  const { show } = options
  const live = () => isLive(options)
  const page = BOT_ITEM_LIMITS.listPage
  const parts = previous ? namedParts(ask.parts, previous) : []
  if (!ask.whole && previous && parts.length > 0) {
    const named = await readNamed(call, parts, live)
    // A host before `uids` answers whole: what it left out isn't gone, so the list is read whole.
    if (!named) {
      return live() ? loadAsked(call, previous, { ...ask, whole: true }, options) : previous
    }
    const merged = mergeNamedBotItems(previous, named, parts)
    if (!ask.more || !live()) {
      return merged
    }
    // A failed page fails only Show more: the named items stand.
    return loadAsked(call, merged, { whole: false, parts: [], more: true }, options).catch(() => {
      throw new BotReadMoreFailed(merged)
    })
  }
  if (ask.whole || !previous) {
    // The depth loaded so far, a page more when asked, a page per call: no answer is larger than one
    // page read alone (a paired connection caps an answer's size).
    const more = ask.more && previous?.nextClosedCursor ? page : 0
    const want = (previous ? botItemsClosedDepth(previous) : page) + more
    const first = await call({})
    // When the first page is as loaded, the pages below it are read again only once it moves (as
    // before), or from where the last read stopped above them: the next page is all that more asks.
    if (previous && !options.pageUnmoved && sameFirstPage(previous, first)) {
      const from = unread.get(previous)
      if (from) {
        return readOwedThenMore(call, previous, from, more > 0 && live(), options)
      }
      return more && live()
        ? loadAsked(call, previous, { whole: false, parts: [], more: true }, options).catch(() => {
            throw new BotReadMoreFailed(previous)
          })
        : previous
    }
    if (show && previous && first.nextClosedCursor && botItemsClosedLoaded(first) < want) {
      show(reuseEqualJson(previous, withLoadedBelow(first, previous)))
    }
    return readBelow(call, first, previous, want, options, more > 0)
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

/** `top` (fresh down to its Closed cursor) with the pages below it read, a page per call, down to
 *  `want` Closed rows. A newer ask waiting stops it after a page: `kept`'s rows below stand until
 *  the next read pages them. A failed page leaves `top`, the
 *  pages below it to load again through Show more (as before), and fails a Show more asked with it.
 *  Equal parts keep `kept`'s identity. */
async function readBelow(
  call: BotItemsListCall,
  top: BotItemsListRead,
  kept: BotItemsListRead | null,
  want: number,
  options: BotItemsListLoadOptions,
  more = false,
  /** Going on from where a read stopped: a failed page leaves `kept` as it was, still owed from here. */
  owed?: string
): Promise<BotItemsListRead> {
  const below: BotItem[] = []
  let loaded = botItemsClosedLoaded(top)
  let last: BotItemsListRead = top
  let paged = false
  const joined = () =>
    last === top ? top : appendBotItemsClosedPage(top, { ...last, items: below })
  while (isLive(options) && last.nextClosedCursor && loaded < want) {
    if (kept && paged && options.waiting?.()) {
      const stopped = joined()
      const value = reuseEqualJson(kept, withLoadedBelow(stopped, kept))
      unread.set(value, stopped.nextClosedCursor!)
      return value
    }
    try {
      last = await call({
        closedCursor: last.nextClosedCursor,
        closedOnly: true,
        closedLimit: Math.min(want - loaded, BOT_ITEM_LIMITS.listPage)
      })
    } catch {
      // Going on from where a read stopped: the pages read stand, the rest still owed.
      if (owed && kept) {
        const stopped = joined()
        const value = reuseEqualJson(kept, withLoadedBelow(stopped, kept))
        unread.set(value, stopped.nextClosedCursor ?? owed)
        return value
      }
      const value = readThrough(reuseEqualJson(kept, top))
      if (more) {
        throw new BotReadMoreFailed(value)
      }
      return value
    }
    paged = true
    const closedRows = last.items.filter(isClosedRow)
    below.push(...closedRows)
    loaded += closedRows.length
  }
  return readThrough(reuseEqualJson(kept, joined()))
}

/** A value read down its whole loaded depth (or as deep as it holds): nothing below is left to page. */
function readThrough(value: BotItemsListRead): BotItemsListRead {
  unread.delete(value)
  return value
}

function isLive(options: BotItemsListLoadOptions): boolean {
  return options.live?.() ?? true
}

/** The named items, a read per `listPage` of them; null when a host before `uids` answered whole
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
  // A page's worth per call, as large an answer as a Closed page (a paired connection caps its size).
  for (let at = 0; at < uids.length; at += BOT_ITEM_LIMITS.listPage) {
    if (first && !live()) {
      return null
    }
    const batch = uids.slice(at, at + BOT_ITEM_LIMITS.listPage)
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
  const { nextClosedCursor: _end, ...rest } = first
  return {
    ...rest,
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
