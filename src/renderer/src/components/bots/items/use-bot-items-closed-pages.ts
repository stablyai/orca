// The list's items with Closed loaded as deep as the owner has asked with Show more. Closed items run
// newest activity first, so between reads a change only adds at the top and loaded pages stay valid: a
// refresh reads none of them again. The items a newer read pushes past its first page stay loaded, so
// none is stranded between that page and the loaded ones. A read that shares no unchanged Closed item
// with what's loaded (more closed in between than one page, unheard) starts Closed from its first page.
import { useCallback, useMemo, useRef, useState } from 'react'
import type { BotRef } from '@/lib/bot-hosts'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { readMoreClosedItems, useStableBotItemChats, type BotItemsRead } from './use-bot-items'

type Pages = {
  /** The chats these pages are of: other chats start from their first page. */
  chats: readonly string[] | null
  /** Every Closed item from the top down to `cursor`. */
  items: BotItem[]
  /** Where the next page starts; null after the last. */
  cursor: string | null
}

export type BotItemsClosedPages = {
  /** The read's items and the loaded Closed ones, each once; none past the loaded end. */
  items: readonly BotItem[]
  /** Reads the next page and returns it; null when there is none. */
  loadMore: (() => Promise<BotItemsClosedPage>) | null
  /** Every Closed item the list counts is loaded. */
  ended: boolean
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

/** `pages` with these Closed items in it, each uid once: the copy of the higher version (ties: the new
 *  one). `pages` itself when nothing changed. */
function withClosed(pages: Pages, items: readonly BotItem[]): Pages {
  const at = new Map(pages.items.map((item, index) => [item.uid, index]))
  let next: BotItem[] | null = null
  for (const item of items) {
    if (!isClosed(item)) {
      continue
    }
    const index = at.get(item.uid)
    const held = index === undefined ? undefined : (next ?? pages.items)[index]
    if (index === undefined) {
      next ??= [...pages.items]
      at.set(item.uid, next.length)
      next.push(item)
    } else if (held !== item && held && item.version >= held.version) {
      next ??= [...pages.items]
      next[index] = item
    }
  }
  return next ? { ...pages, items: next } : pages
}

/** Whether `to` joins what's loaded with nothing between: its first page ends where `from`'s did (a
 *  named read keeps it), or one of its Closed items is held still unchanged in place (everything above
 *  it changed since, so it's all in `to`; everything below it is held). */
function joins(pages: Pages, from: BotItemsRead, to: BotItemsRead): boolean {
  if (to.nextClosedCursor === from.nextClosedCursor) {
    return true
  }
  const held = new Map(pages.items.map((item) => [item.uid, item]))
  return to.items.some((item) => {
    const kept = held.get(item.uid)
    return (
      isClosed(item) &&
      kept !== undefined &&
      kept.lastActivityAt === item.lastActivityAt &&
      kept.number === item.number
    )
  })
}

/** Every Closed item `read` counts is loaded or in it, when the loaded pages say they reach the end. */
function countsMet(pages: Pages, read: BotItemsRead): boolean {
  if (pages.cursor !== null) {
    return true
  }
  const uids = new Set(pages.items.map((item) => item.uid))
  read.items.forEach((item) => isClosed(item) && uids.add(item.uid))
  return uids.size >= (read.counts.done ?? 0) + (read.counts.canceled ?? 0)
}

/** Loaded pages carried from the read they continued (`from`) to a newer one (`to`): `from`'s Closed
 *  items kept, so a row `to` pushed past its first page stays. Null, back to `to`'s first page, when
 *  `to` holds every Closed item itself, or doesn't join them, or counts some they lack (a host clock
 *  set back can close an item below the loaded end). */
function carry(pages: Pages, from: BotItemsRead, to: BotItemsRead | null): Pages | null {
  const kept = withClosed(pages, from.items)
  if (!to || to === from) {
    return kept
  }
  return to.nextClosedCursor && joins(kept, from, to) && countsMet(kept, to) ? kept : null
}

/** The read's items (Closed ones only down to the loaded end) and the loaded ones, each uid once. */
function loadedItems(read: BotItemsRead | null, pages: Pages | null): readonly BotItem[] {
  if (!read) {
    return pages?.items ?? NONE
  }
  const end = cursorPlace(pages ? pages.cursor : read.nextClosedCursor)
  const loaded = new Map(pages?.items.map((item) => [item.uid, item]))
  const items = read.items.flatMap((item) => {
    const page = loaded.get(item.uid)
    loaded.delete(item.uid)
    // A named read can carry a Closed item from a page not loaded yet: it waits for its page.
    if (!page && isClosed(item) && end && !reaches(item, end)) {
      return []
    }
    return [page && page.version > item.version ? page : item]
  })
  return loaded.size > 0 ? [...items, ...loaded.values()] : items
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
  // Only a newer read of the same chats carries the pages; another filter's read is its own list.
  const [last, setLast] = useState({ read, chats })
  if (last.read !== read || last.chats !== chats) {
    setLast({ read, chats })
    if (pages && last.read && last.chats === chats) {
      const next = carry(pages, last.read, read)
      if (next !== pages) {
        setPages(next)
      }
    }
  }
  const latest = useRef({ read, chats })
  latest.current = { read, chats }
  const generation = useRef(0)

  const cursor = pages ? pages.cursor : (read?.nextClosedCursor ?? null)
  const loadMore = useCallback(async (): Promise<BotItemsClosedPage> => {
    const from = read
    if (!from || !cursor) {
      return { items: NONE, more: false }
    }
    const mine = ++generation.current
    const next = await readMoreClosedItems({ hostId, id }, cursor, chats)
    // A page of a filter no longer shown is dropped.
    if (generation.current === mine && latest.current.chats === chats) {
      setPages((prev) => {
        const held: Pages = prev && prev.chats === chats ? prev : { chats, items: [], cursor: null }
        const grown = withClosed(held, next.items)
        // The read this page continues stays loaded, so a newer one landed meanwhile strands nothing.
        return carry({ ...grown, cursor: next.nextClosedCursor ?? null }, from, latest.current.read)
      })
    }
    return { items: next.items, more: Boolean(next.nextClosedCursor) }
  }, [read, cursor, hostId, id, chats])

  const items = useMemo(() => loadedItems(read, pages), [read, pages])
  return {
    items,
    loadMore: cursor ? loadMore : null,
    ended: read !== null && cursor === null
  }
}
