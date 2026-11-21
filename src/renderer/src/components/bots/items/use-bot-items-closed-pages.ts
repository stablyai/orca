// The list's items with Closed loaded as deep as the owner has asked with Show more. A read of only the
// items a notice named leaves every other row where it was, so loaded pages stay as they are and take
// those items' copies from it: nothing is read again. A whole read moves where its first page ends, so
// the loaded depth is read again from the new end: every counted item stays reachable, none is
// stranded between a stale page and a spent cursor.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BotRef } from '@/lib/bot-hosts'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { botItemsNamedSince } from '../../../../../shared/bots/bot-item-merge'
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

/** A cursor's place: `at:number` of the last row before it. */
function cursorPlace(cursor: string | null | undefined): { at: number; number: number } | null {
  const [at, number] = (cursor ?? '').split(':').map(Number)
  return Number.isFinite(at) && Number.isFinite(number) ? { at: at!, number: number! } : null
}

/** At or above the place in Closed order (newest activity first, then highest number). */
function reaches(item: BotItem, place: { at: number; number: number }): boolean {
  return (
    item.lastActivityAt > place.at ||
    (item.lastActivityAt === place.at && item.number >= place.number)
  )
}

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
  const place = cursorPlace(end)
  const paged = new Map(pages.map((item) => [item.uid, item]))
  const items = read.items.flatMap((item) => {
    const page = paged.get(item.uid)
    paged.delete(item.uid)
    if (page) {
      return [item.version > page.version ? item : page]
    }
    return isClosed(item) && place && !reaches(item, place) ? [] : [item]
  })
  return paged.size > 0 ? [...items, ...paged.values()] : items
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
  // A read that is the pages' own with only named items read again: the named items' copies are in it
  // now (none for a deleted one), so the pages drop theirs and carry on. Any other new read reads the
  // depth again.
  const named = pages && read && pages.base !== read ? botItemsNamedSince(read, pages.base) : null
  if (pages && read && named) {
    setPages({ ...pages, base: read, items: pages.items.filter((item) => !named.has(item.uid)) })
  }
  const generation = useRef(0)
  const latest = useRef(read)
  latest.current = read

  const depth = pages?.depth ?? 0
  const current = pages !== null && pages.base === read
  useEffect(() => {
    if (!read || depth === 0 || current) {
      return
    }
    const mine = ++generation.current
    void (async () => {
      const items: BotItem[] = []
      let cursor = read.nextClosedCursor ?? null
      for (let page = 0; page < depth && cursor; page++) {
        const next = await readMoreClosedItems({ hostId, id }, cursor, chats)
        items.push(...next.items)
        cursor = next.nextClosedCursor ?? null
      }
      if (generation.current === mine) {
        setPages({ base: read, chats, depth, items, cursor })
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
    const next = await readMoreClosedItems({ hostId, id }, cursor, chats)
    if (generation.current === mine) {
      // Items a named read refreshed while this page was out: the read's copies are the newer ones.
      const since = latest.current ? botItemsNamedSince(latest.current, read) : null
      const fresh = since ? next.items.filter((item) => !since.has(item.uid)) : next.items
      setPages((prev) => {
        // Still the pages this one continues (a named read since kept them): it joins them.
        const same = prev !== null && prev.chats === chats && prev.cursor === cursor
        return {
          base: same ? prev.base : read,
          chats,
          depth: (same ? prev.depth : 0) + 1,
          items: [...(same ? prev.items : []), ...fresh],
          cursor: next.nextClosedCursor ?? null
        }
      })
    }
    return { items: next.items, more: Boolean(next.nextClosedCursor) }
  }, [read, cursor, hostId, id, chats])

  return {
    items,
    loadMore: cursor ? loadMore : null,
    ended: read !== null && cursor === null && (current || depth === 0 || allShown),
    endAt: cursor ? (cursorPlace(cursor)?.at ?? null) : null
  }
}
