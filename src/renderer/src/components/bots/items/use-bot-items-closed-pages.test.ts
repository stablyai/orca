// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'

const host = vi.hoisted((): { closed: string[] } => ({ closed: [] }))

// The host's Closed list, newest first, paged by 50 after a cursor naming the last uid shown.
vi.mock('./use-bot-items', () => ({
  readMoreClosedItems: async (_bot: unknown, cursor: string) => {
    const from = host.closed.indexOf(cursor) + 1
    const page = host.closed.slice(from, from + 50)
    const more = from + 50 < host.closed.length
    return { items: page.map(closed), ...(more ? { nextClosedCursor: page.at(-1) } : {}) }
  }
}))

import { useBotItemsClosedPages } from './use-bot-items-closed-pages'

afterEach(cleanup)

function closed(uid: string): BotItem {
  return makeTestBotItem(1, { uid, status: 'done' })
}

/** The list read: its first Closed page and the cursor after it. */
function listRead() {
  const first = host.closed.slice(0, 50)
  return {
    items: first.map(closed),
    counts: { done: host.closed.length },
    seenEventId: 'e0',
    ...(host.closed.length > 50 ? { nextClosedCursor: first.at(-1) } : {})
  }
}

const BOT = { hostId: 'local', id: 'bot-1' } as const

it('keeps every closed item reachable when a refresh moves the first page’s end', async () => {
  host.closed = Array.from({ length: 100 }, (_, index) => `c${index + 1}`)
  const view = renderHook(({ read }) => useBotItemsClosedPages(BOT, read, null), {
    initialProps: { read: listRead() }
  })
  await act(() => view.result.current.loadMore!())
  expect(view.result.current.loadMore).toBeNull()

  // Another item closes: the first page is now new + c1..c49, so c50 moves past it.
  host.closed = ['new', ...host.closed]
  const read = listRead()
  view.rerender({ read })

  // Show more reaches everything the count names.
  await waitFor(() => expect(view.result.current.loadMore).not.toBeNull())
  while (view.result.current.loadMore) {
    await act(() => view.result.current.loadMore!())
  }
  const shown = new Set([...read.items, ...view.result.current.items].map((item) => item.uid))
  expect(shown.size).toBe(101)
})
