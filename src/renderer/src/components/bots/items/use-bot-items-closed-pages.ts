// Closed items past the list's first page, as deep as the owner has asked with Show more. Closed items
// run newest activity first, so a change only adds at the top and a loaded page stays valid: a refresh
// reads none of them again. An item a newer list read pushed past its first page stays loaded, so none
// is stranded between that page and the loaded ones.
import { useCallback, useRef, useState } from 'react'
import type { BotRef } from '@/lib/bot-hosts'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { readMoreClosedItems, useStableBotItemChats, type BotItemsRead } from './use-bot-items'

type Pages = {
  /** The chats these pages are of: other chats start from their first page. */
  chats: readonly string[] | null
  items: BotItem[]
  /** Where the next page starts; null after the last. */
  cursor: string | null
}

export type BotItemsClosedPages = {
  items: readonly BotItem[]
  /** Reads the next page and returns it; null when there is none. */
  loadMore: (() => Promise<BotItemsClosedPage>) | null
  /** Every Closed item the list counts is loaded. */
  ended: boolean
}

export type BotItemsClosedPage = { items: readonly BotItem[]; more: boolean }

const NONE: readonly BotItem[] = []

const isClosed = (item: BotItem): boolean => item.status === 'done' || item.status === 'canceled'

/** `pages` with the Closed items of a list read it has replaced, each kept or newer copy by uid. */
function keepClosedOf(pages: Pages, replaced: BotItemsRead): Pages {
  const at = new Map(pages.items.map((item, index) => [item.uid, index]))
  let items: BotItem[] | null = null
  for (const item of replaced.items) {
    if (!isClosed(item)) {
      continue
    }
    const index = at.get(item.uid)
    if (index === undefined) {
      items ??= [...pages.items]
      items.push(item)
    } else if (pages.items[index] !== item) {
      items ??= [...pages.items]
      items[index] = item
    }
  }
  return items ? { ...pages, items } : pages
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
  const [lastRead, setLastRead] = useState(read)
  if (lastRead !== read) {
    setLastRead(read)
    if (pages && lastRead) {
      const next = keepClosedOf(pages, lastRead)
      if (next !== pages) {
        setPages(next)
      }
    }
  }
  const generation = useRef(0)

  const cursor = pages ? pages.cursor : (read?.nextClosedCursor ?? null)
  const loadMore = useCallback(async (): Promise<BotItemsClosedPage> => {
    if (!read || !cursor) {
      return { items: NONE, more: false }
    }
    const mine = ++generation.current
    const next = await readMoreClosedItems({ hostId, id }, cursor, chats)
    if (generation.current === mine) {
      setPages((prev) => ({
        chats,
        items: [...(prev?.chats === chats ? prev.items : []), ...next.items],
        cursor: next.nextClosedCursor ?? null
      }))
    }
    return { items: next.items, more: Boolean(next.nextClosedCursor) }
  }, [read, cursor, hostId, id, chats])

  return {
    // The list's own copies win by uid.
    items: pages?.items ?? NONE,
    loadMore: cursor ? loadMore : null,
    ended: read !== null && cursor === null
  }
}
