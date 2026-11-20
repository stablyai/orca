// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'

const host = vi.hoisted((): { closed: string[] } => ({ closed: [] }))

// The host's Closed list, newest first, paged by 50 after a cursor naming the last uid shown.
vi.mock('./use-bot-items', () => ({
  useStableBotItemChats: (chatIds: readonly string[] | null) => chatIds,
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

async function loadAll(view: { result: { current: ReturnType<typeof useBotItemsClosedPages> } }) {
  while (view.result.current.loadMore) {
    await act(() => view.result.current.loadMore!())
  }
}

it('keeps every closed item reachable when a refresh moves the first page’s end', async () => {
  host.closed = Array.from({ length: 100 }, (_, index) => `c${index + 1}`)
  const view = renderHook(({ read }) => useBotItemsClosedPages(BOT, read, null), {
    initialProps: { read: listRead() }
  })
  await loadAll(view)

  // Another item closes: the first page is now new + c1..c49, so c50 moves past it.
  host.closed = ['new', ...host.closed]
  view.rerender({ read: listRead() })

  // Nothing is read again, and c50 stays.
  expect(view.result.current.loadMore).toBeNull()
  expect(new Set(view.result.current.items.map((item) => item.uid)).size).toBe(101)
})

it('starts Closed from its first page when more closed unheard than one page holds', async () => {
  host.closed = Array.from({ length: 100 }, (_, index) => `c${index + 1}`)
  const view = renderHook(({ read }) => useBotItemsClosedPages(BOT, read, null), {
    initialProps: { read: listRead() }
  })
  await loadAll(view)

  host.closed = [...Array.from({ length: 60 }, (_, index) => `n${index + 1}`), ...host.closed]
  view.rerender({ read: listRead() })
  await loadAll(view)

  expect(new Set(view.result.current.items.map((item) => item.uid)).size).toBe(160)
})
