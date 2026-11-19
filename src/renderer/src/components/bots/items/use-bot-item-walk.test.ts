// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { BotItem } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItemsClosedPage } from './use-bot-items-closed-pages'
import type { BotItemsShownList } from './use-bot-items-shown-list'
import { useBotItemWalk } from './use-bot-item-walk'

const open = (uid: string) => makeTestBotItem(1, { uid, status: 'working' })
const closed = (uid: string) => makeTestBotItem(1, { uid, status: 'done' })

/** Two open items and one loaded Closed item of three on the host. */
function list(
  loadMoreClosed: (() => Promise<BotItemsClosedPage>) | null,
  closedRows: BotItem[] = [closed('c1')]
): BotItemsShownList {
  const working: BotItem[] = [open('a'), open('b')]
  return {
    read: null,
    chatRead: { read: null, failed: false, retry: () => {} },
    items: [],
    shown: [],
    groups: { needs_you: [], working, planned: [], snoozed: [], stale: [], closed: closedRows },
    staleDays: null,
    closedTotal: 3,
    loadMoreClosed,
    closedEnded: false
  }
}

function deferred(): {
  promise: Promise<BotItemsClosedPage>
  settle: (page: BotItemsClosedPage) => void
  fail: () => void
} {
  let settle!: (page: BotItemsClosedPage) => void
  let fail!: () => void
  const promise = new Promise<BotItemsClosedPage>((resolve, reject) => {
    settle = resolve
    fail = () => reject(new Error('offline'))
  })
  return { promise, settle, fail }
}

it('steps in order, holds the current item while paging, and stops at the ends', async () => {
  const page = deferred()
  const loadMore = vi.fn(() => page.promise)
  const view = renderHook(() => useBotItemWalk(list(loadMore), 'bot-2'))
  act(() => view.result.current.open('a'))
  expect(view.result.current.place).toEqual({ index: 1, total: 5 })
  expect(view.result.current.canStep(-1)).toBe(false)
  act(() => view.result.current.step(-1))
  expect(view.result.current.uid).toBe('a')
  act(() => view.result.current.step(1))
  expect(view.result.current.uid).toBe('b')
  expect(view.result.current.place).toEqual({ index: 2, total: 5 })
  act(() => view.result.current.step(1))
  expect(view.result.current.uid).toBe('c1')

  act(() => view.result.current.step(1))
  expect(loadMore).toHaveBeenCalledOnce()
  expect(view.result.current.uid).toBe('c1')
  expect(view.result.current.pending).toBe(true)
  expect(view.result.current.canStep(1)).toBe(false)
  expect(view.result.current.canStep(-1)).toBe(false)

  await act(async () => page.settle({ items: [closed('c1'), closed('c2')], more: false }))
  expect(view.result.current.uid).toBe('c2')
  expect(view.result.current.pending).toBe(false)
  // The host had one fewer than counted: the walk ends here.
  expect(view.result.current.place).toEqual({ index: 4, total: 4 })
  expect(view.result.current.canStep(1)).toBe(false)
})

it('keeps the place when a page read fails, and Retry reads it again', async () => {
  const first = deferred()
  const loadMore = vi.fn(() => first.promise)
  const view = renderHook(() => useBotItemWalk(list(loadMore), 'bot-3'))
  act(() => view.result.current.open('c1'))
  act(() => view.result.current.step(1))
  await act(async () => {
    first.fail()
    await first.promise.catch(() => {})
  })
  expect(view.result.current.failed).toBe(true)
  expect(view.result.current.uid).toBe('c1')
  expect(view.result.current.place).toEqual({ index: 3, total: 5 })
  expect(view.result.current.canStep(-1)).toBe(true)

  loadMore.mockResolvedValueOnce({ items: [closed('c2')], more: true })
  await act(async () => view.result.current.retry())
  expect(loadMore).toHaveBeenCalledTimes(2)
  expect(view.result.current.failed).toBe(false)
  expect(view.result.current.uid).toBe('c2')
})

it('drops a deleted item from the walk once stepped away from it', () => {
  const view = renderHook(() => useBotItemWalk(list(null), 'bot-4'))
  act(() => view.result.current.open('b'))
  act(() => view.result.current.markGone('b'))
  expect(view.result.current.place).toEqual({ index: 2, total: 5 })
  act(() => view.result.current.step(-1))
  expect(view.result.current.uid).toBe('a')
  expect(view.result.current.place).toEqual({ index: 1, total: 4 })
  act(() => view.result.current.step(1))
  expect(view.result.current.uid).toBe('c1')
})

it('has no walk for an item outside the list, and Back reports what it left', () => {
  const view = renderHook(() => useBotItemWalk(list(null), 'bot-5'))
  act(() => view.result.current.open('elsewhere'))
  expect(view.result.current.place).toBeNull()
  expect(view.result.current.canStep(1)).toBe(false)
  let left: ReturnType<typeof view.result.current.close> = null
  act(() => {
    left = view.result.current.close()
  })
  expect(left).toEqual({ uid: 'elsewhere', walk: null })
  expect(view.result.current.uid).toBeNull()
})

it('keeps an item closed after opening out of the walk; the next step still pages to the original', async () => {
  const loadMore = vi.fn(async () => ({ items: [closed('c2')], more: true }))
  const view = renderHook(({ rows }) => useBotItemWalk(list(loadMore, rows), 'bot-6'), {
    initialProps: { rows: [closed('c1')] }
  })
  act(() => view.result.current.open('c1'))
  // A refresh while the item is open: a newly closed item now leads Closed.
  view.rerender({ rows: [closed('closed-since'), closed('c1')] })
  await act(async () => view.result.current.step(1))
  expect(loadMore).toHaveBeenCalledOnce()
  expect(view.result.current.uid).toBe('c2')
  expect(view.result.current.place).toEqual({ index: 4, total: 5 })
})

it('reopens the open item after the panel unmounts and mounts again, per bot', () => {
  const first = renderHook(() => useBotItemWalk(list(null), 'remount'))
  act(() => first.result.current.open('b'))
  first.unmount()
  const other = renderHook(() => useBotItemWalk(list(null), 'remount-other'))
  expect(other.result.current.uid).toBeNull()

  const again = renderHook(() => useBotItemWalk(list(null), 'remount'))
  expect(again.result.current.uid).toBe('b')
  expect(again.result.current.place).toEqual({ index: 2, total: 5 })
  act(() => again.result.current.close())
  again.unmount()
  expect(renderHook(() => useBotItemWalk(list(null), 'remount')).result.current.uid).toBeNull()
})

it('falls back to the list when the reopened item was deleted meanwhile', () => {
  const first = renderHook(() => useBotItemWalk(list(null), 'remount-deleted'))
  act(() => first.result.current.open('a'))
  first.unmount()
  const again = renderHook(() => useBotItemWalk(list(null), 'remount-deleted'))
  act(() => again.result.current.markGone('a'))
  expect(again.result.current.uid).toBeNull()
})
