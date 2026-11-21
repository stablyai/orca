// Closed items past the list's first page, as deep as the owner has asked with Show more. A refreshed
// list moves where its first page ends, so the loaded depth is read again from the new end: every
// counted item stays reachable, none is stranded between a stale page and a spent cursor.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BotRef } from '@/lib/bot-hosts'
import type { BotItem } from '../../../../../shared/bots/bot-items'
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
  items: readonly BotItem[]
  /** Reads the next page and returns it; null when there is none, or while the loaded depth is read
   *  again. */
  loadMore: (() => Promise<BotItemsClosedPage>) | null
  /** Every Closed item the list counts is loaded. */
  ended: boolean
}

export type BotItemsClosedPage = { items: readonly BotItem[]; more: boolean }

const NONE: readonly BotItem[] = []

export function useBotItemsClosedPages(
  bot: BotRef,
  read: BotItemsRead | null,
  chatIds: readonly string[] | null
): BotItemsClosedPages {
  const { hostId, id } = bot
  const chats = useStableBotItemChats(chatIds)
  const [kept, setPages] = useState<Pages | null>(null)
  const pages = kept?.chats === chats ? kept : null
  const generation = useRef(0)

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

  const cursor = current ? pages.cursor : depth === 0 ? (read?.nextClosedCursor ?? null) : null
  const loadMore = useCallback(async (): Promise<BotItemsClosedPage> => {
    if (!read || !cursor) {
      return { items: NONE, more: false }
    }
    const mine = ++generation.current
    const next = await readMoreClosedItems({ hostId, id }, cursor, chats)
    if (generation.current === mine) {
      setPages((prev) => {
        const same = prev?.base === read && prev.chats === chats
        return {
          base: read,
          chats,
          depth: (same ? prev.depth : 0) + 1,
          items: [...(same ? prev.items : []), ...next.items],
          cursor: next.nextClosedCursor ?? null
        }
      })
    }
    return { items: next.items, more: Boolean(next.nextClosedCursor) }
  }, [read, cursor, hostId, id, chats])

  return {
    // While the depth is read again, the old rows stay up; the list's own copies win by uid.
    items: pages?.items ?? NONE,
    loadMore: cursor ? loadMore : null,
    ended: read !== null && cursor === null && (current || depth === 0)
  }
}
