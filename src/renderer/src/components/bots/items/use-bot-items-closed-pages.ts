// The list's items with Closed loaded as deep as the owner has asked with Show more. A read of only the
// items a notice named leaves every other row where it was, so loaded pages stay as they are and take
// those items' copies from it: nothing is read again. A whole read moves where its first page ends, so
// the loaded depth is read again from the new end: every counted item stays reachable, none is
// stranded between a stale page and a spent cursor.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BotRef } from '@/lib/bot-hosts'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import {
  botItemCursorPlace,
  botItemReaches,
  botItemsNamedSince
} from '../../../../../shared/bots/bot-item-merge'
import { readMoreClosedItems, useStableBotItemChats, type BotItemsRead } from './use-bot-items'

type Pages = {
  /** The list read these pages continue, and its chats: other chats start from their first page. */
  base: BotItemsRead
  chats: readonly string[] | null
  depth: number
  items: BotItem[]
  cursor: string | null
}

export type BotItemsClosedPages = {
  /** The read's items and the loaded Closed ones, each once; none past the loaded end. */
  items: readonly BotItem[]
  /** Reads the next page and returns it; null when there is none, or while the loaded depth is read
   *  again. */
  loadMore: (() => Promise<BotItemsClosedPage>) | null
  /** Every Closed item the list counts is loaded. */
  ended: boolean
  /** The last activity of the loaded end, while more Closed pages remain. */
  endAt: number | null
}

export type BotItemsClosedPage = { items: readonly BotItem[]; more: boolean }

const NONE: readonly BotItem[] = []

const isClosed = (item: BotItem): boolean => item.status === 'done' || item.status === 'canceled'

/** The read's items and the loaded pages', each uid once. A named read can hold a Closed item from a
 *  page not loaded yet: it waits for its page. A page's copy stands unless the read's is a newer
 *  version. */
function loadedItems(
  read: BotItemsRead | null,
  pages: readonly BotItem[],
  end: string | null
): readonly BotItem[] {
  if (!read) {
    return NONE
  }
  const place = botItemCursorPlace(end)
  const paged = new Map(pages.map((item) => [item.uid, item]))
  const items = read.items.flatMap((item) => {
    const page = paged.get(item.uid)
    paged.delete(item.uid)
    if (page) {
      return [item.version > page.version ? item : page]
    }
    return isClosed(item) && place && !botItemReaches(item, place) ? [] : [item]
  })
  return paged.size > 0 ? [...items, ...paged.values()] : items
}

function carriedPages(
  pages: Pages,
  read: BotItemsRead,
  named: ReadonlyMap<string, BotItem | null>
): BotItem[] {
  const inRead = new Set(read.items.map((item) => item.uid))
  const held = new Map<string, BotItem>()
  for (const item of [...pages.base.items.filter(isClosed), ...pages.items]) {
    if (!held.has(item.uid)) {
      held.set(item.uid, item)
    }
  }
  // A named item newly Closed above the pages' end that the read's first page has no room for.
  const end = botItemCursorPlace(pages.cursor)
  named.forEach((copy, uid) => {
    if (copy && isClosed(copy) && !held.has(uid) && (!end || botItemReaches(copy, end))) {
      held.set(uid, copy)
    }
  })
  return [...held.values()].flatMap((item) => {
    if (inRead.has(item.uid)) {
      return []
    }
    if (!named.has(item.uid)) {
      return [item]
    }
    const copy = named.get(item.uid)
    return copy && isClosed(copy) ? [copy] : []
  })
}

export function useBotItemsClosedPages(
  bot: BotRef,
  read: BotItemsRead | null,
  chatIds: readonly string[] | null
): BotItemsClosedPages {
  const { hostId, id } = bot
  const chats = useStableBotItemChats(chatIds)
  const [kept, setPages] = useState<Pages | null>(null)
  const pages = kept?.chats === chats ? kept : null
  // A read that is the pages' own with only named items read again carries them on, nothing read
  // again: rows it pushed past its first page join the pages, and each named item takes its new copy
  // (out of the pages when it's open, in the read, or gone). Any other new read reads the depth again.
  const named = pages && read && pages.base !== read ? botItemsNamedSince(read, pages.base) : null
  if (pages && read && named) {
    setPages({ ...pages, base: read, items: carriedPages(pages, read, named) })
  }
  const generation = useRef(0)
  const pendingMore = useRef(0)
  const latest = useRef(read)
  useEffect(() => {
    latest.current = read
  }, [read])

  const depth = pages?.depth ?? 0
  const current = pages !== null && pages.base === read
  useEffect(() => {
    if (!read || depth === 0 || current) {
      return
    }
    const mine = ++generation.current
    // A Show more still out is dropped by this read, so its page is read here too.
    const want = depth + pendingMore.current
    void (async () => {
      const items: BotItem[] = []
      let cursor = read.nextClosedCursor ?? null
      for (let page = 0; page < want && cursor; page++) {
        const next = await readMoreClosedItems({ hostId, id }, cursor, chats)
        items.push(...next.items)
        cursor = next.nextClosedCursor ?? null
      }
      if (generation.current === mine) {
        setPages({ base: read, chats, depth: want, items, cursor })
      }
    })().catch((error: unknown) => {
      console.warn('[bots] items: reading Closed pages again failed', error)
      if (generation.current === mine) {
        // Back to the first page: what's shown matches the counts, and Show more reads on from there.
        setPages(null)
      }
    })
  }, [read, depth, current, hostId, id, chats])

  // While the depth is read again, the old rows stay up, to their old end.
  const shownPages = pages?.items ?? NONE
  const shownEnd = pages ? pages.cursor : (read?.nextClosedCursor ?? null)
  const items = useMemo(() => loadedItems(read, shownPages, shownEnd), [read, shownPages, shownEnd])
  // Every Closed item the read counts is shown (a named read moved the last unloaded one out): no more.
  const closedTotal = (read?.counts.done ?? 0) + (read?.counts.canceled ?? 0)
  const allShown = useMemo(
    () => new Set(items.filter(isClosed).map((item) => item.uid)).size >= closedTotal,
    [items, closedTotal]
  )
  const paged = current ? pages.cursor : depth === 0 ? (read?.nextClosedCursor ?? null) : null
  const cursor = allShown ? null : paged
  const loadMore = useCallback(async (): Promise<BotItemsClosedPage> => {
    if (!read || !cursor) {
      return { items: NONE, more: false }
    }
    const mine = ++generation.current
    pendingMore.current += 1
    const next = await readMoreClosedItems({ hostId, id }, cursor, chats).finally(() => {
      pendingMore.current -= 1
    })
    const now = latest.current
    const since =
      now && now !== read ? botItemsNamedSince(now, read) : new Map<string, BotItem | null>()
    if (generation.current === mine && !since) {
      // What changed while this page was out is no longer known: the page shows, and the pages are read
      // again from the newest read, this one's depth included.
      setPages((prev) => {
        const same = prev !== null && prev.chats === chats && prev.cursor === cursor
        return {
          base: read,
          chats,
          depth: (same ? prev.depth : 0) + 1,
          items: [...(same ? prev.items : []), ...next.items],
          cursor: next.nextClosedCursor ?? null
        }
      })
    }
    if (generation.current === mine && since) {
      // Items a named read refreshed while this page was out: the read's copies are the newer ones.
      const inNow = new Set(now?.items.map((item) => item.uid))
      const fresh = next.items.flatMap((item) => {
        if (!since.has(item.uid)) {
          return [item]
        }
        const copy = since.get(item.uid)
        return copy && isClosed(copy) && !inNow.has(item.uid) ? [copy] : []
      })
      // A named item newly Closed within this page's span that the page didn't hold joins it too.
      const pageEnd = botItemCursorPlace(next.nextClosedCursor)
      const paged = new Set(fresh.map((item) => item.uid))
      const joining = [...since].flatMap(([uid, copy]) =>
        copy &&
        isClosed(copy) &&
        !inNow.has(uid) &&
        !paged.has(uid) &&
        (!pageEnd || botItemReaches(copy, pageEnd))
          ? [copy]
          : []
      )
      setPages((prev) => {
        // Still the pages this one continues (a named read since kept them): it joins them.
        const same = prev !== null && prev.chats === chats && prev.cursor === cursor
        const held = new Set(same ? prev.items.map((item) => item.uid) : [])
        return {
          base: same ? prev.base : read,
          chats,
          depth: (same ? prev.depth : 0) + 1,
          items: [
            ...(same ? prev.items : []),
            ...fresh,
            ...joining.filter((item) => !held.has(item.uid))
          ],
          cursor: next.nextClosedCursor ?? null
        }
      })
    }
    // Dropped for a read of the depth again (which reads this page too): nothing shows from it yet.
    return generation.current === mine
      ? { items: next.items, more: Boolean(next.nextClosedCursor) }
      : { items: NONE, more: true }
  }, [read, cursor, hostId, id, chats])

  return {
    items,
    loadMore: cursor ? loadMore : null,
    ended: read !== null && cursor === null && (current || depth === 0 || allShown),
    endAt: cursor ? (botItemCursorPlace(cursor)?.at ?? null) : null
  }
}
