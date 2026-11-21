// Work contracts for the Items list loader: calls per read, as a host counts them.
import { describe, expect, it } from 'vitest'
import { loadBotItemsList, type BotItemsListCall } from './bot-items-list-load'
import { BOT_ITEMS_WORKER_LINKED } from './bot-items-notice-parts'
import { MORE, WHOLE, closed, host, seeded } from './bot-items-list-load.test-fixture'

describe('loadBotItemsList work', () => {
  it('reads the loaded depth again on a whole read, page by page from an older host', async () => {
    const items = seeded()
    for (const older of [false, true]) {
      const limits: unknown[] = []
      const pages: unknown[] = []
      const call: BotItemsListCall = (params) => {
        limits.push(params.closedLimit)
        if (params.closedCursor) {
          pages.push(params.closedOnly)
        }
        return host(items, older)(params)
      }
      let read = await loadBotItemsList(call, null, WHOLE)
      read = await loadBotItemsList(call, read, MORE)
      read = await loadBotItemsList(call, read, MORE)
      read = await loadBotItemsList(call, read, WHOLE)
      expect(read.items.filter(closed)).toHaveLength(150)
      expect(read.items.filter((item) => !closed(item))).toHaveLength(100)
      // A page per call: no answer larger than one page read alone.
      expect(
        limits.every((limit) => limit === undefined || (typeof limit === 'number' && limit <= 50))
      ).toBe(true)
      // A page below the first asks for Closed rows alone, never the open list again.
      expect(pages.length).toBeGreaterThan(0)
      expect(pages.every((closedOnly) => closedOnly === true)).toBe(true)
    }
    // Unchanged, its first page is all a whole read asks of a host, older or not.
    for (const older of [false, true]) {
      const inner = host(items, older)
      let read = await loadBotItemsList(inner, null, WHOLE)
      read = await loadBotItemsList(inner, read, MORE)
      let calls = 0
      const counted: BotItemsListCall = (params) => {
        calls += 1
        return inner(params)
      }
      expect(await loadBotItemsList(counted, read, WHOLE)).toBe(read)
      expect(calls).toBe(1)
      // With more asked too, the next page is all it reads.
      calls = 0
      const deeper = await loadBotItemsList(counted, read, { whole: true, parts: [], more: true })
      expect(calls).toBe(2)
      expect(deeper.items.filter(closed)).toHaveLength(150)
      // The chat-filtered list reads its loaded pages again, as it always did: Closed rows alone.
      calls = 0
      const pages: unknown[] = []
      const paged: BotItemsListCall = (params) => {
        if (params.closedCursor) {
          pages.push(params.closedOnly)
        }
        return counted(params)
      }
      await loadBotItemsList(paged, read, WHOLE, { pageUnmoved: true })
      expect(calls).toBe(2)
      expect(older || pages.every((closedOnly) => closedOnly === true)).toBe(true)
      expect(pages).toHaveLength(1)
    }
  })

  it('pages on from where a read stopped for a newer ask, each page once', async () => {
    const items = seeded()
    const inner = host(items)
    let read = await loadBotItemsList(inner, null, WHOLE)
    read = await loadBotItemsList(inner, read, MORE)
    read = await loadBotItemsList(inner, read, MORE)
    Object.assign(items[0]!, { status: 'needs_you', version: 2 })
    const cursors: unknown[] = []
    const call: BotItemsListCall = (params) => {
      cursors.push(params.closedCursor ?? 'first')
      return inner(params)
    }
    read = await loadBotItemsList(call, read, WHOLE, { waiting: () => true })
    // Its first page unchanged, the next whole read pages only what the last left.
    read = await loadBotItemsList(call, read, WHOLE)
    expect(cursors).toEqual(['first', '251:251', 'first', '201:201'])
    cursors.length = 0
    expect(await loadBotItemsList(call, read, WHOLE)).toBe(read)
    expect(cursors).toEqual(['first'])
  })

  it('stops paging down the depth once nothing shows the list', async () => {
    const older = host(seeded(), true)
    let read = await loadBotItemsList(older, null, WHOLE)
    read = await loadBotItemsList(older, read, MORE)
    read = await loadBotItemsList(older, read, MORE)
    let calls = 0
    const counted: BotItemsListCall = (params) => {
      calls += 1
      return older(params)
    }
    await loadBotItemsList(counted, read, WHOLE, { live: () => calls === 0, pageUnmoved: true })
    expect(calls).toBe(1)
  })

  it('reads the loaded items that link a worker for a worker change, in no more calls than a whole read', async () => {
    const items = seeded()
    const link = {
      kind: 'dispatch' as const,
      ref: 'ctx_1',
      latest: null,
      title: null,
      state: 'working' as const,
      host: null,
      startedAt: null,
      settledAt: null,
      report: null,
      pr: null
    }
    for (const item of items.slice(0, 3)) {
      item.links = [link]
    }
    const asked: unknown[] = []
    const inner = host(items)
    const call: BotItemsListCall = (params) => {
      asked.push(params.uids ?? 'whole')
      return inner(params)
    }
    let read = await loadBotItemsList(call, null, WHOLE)
    items[1]!.links = [{ ...link, state: 'completed' }]
    asked.length = 0
    const worker = { whole: false, parts: [BOT_ITEMS_WORKER_LINKED], more: false }
    read = await loadBotItemsList(call, read, worker)
    expect(asked).toEqual([['i3', 'i2', 'i1']])
    const changed = read.items.find((item) => item.uid === 'i2')?.links[0]
    expect(changed?.kind === 'dispatch' ? changed.state : null).toBe('completed')
    // Fifty a call while that is fewer calls than the loaded pages; beyond it, the list reads whole.
    for (const item of items.slice(0, 60)) {
      item.links = [link]
    }
    read = await loadBotItemsList(call, null, WHOLE)
    read = await loadBotItemsList(call, read, MORE)
    asked.length = 0
    read = await loadBotItemsList(call, read, worker)
    expect(asked.map((uids) => (Array.isArray(uids) ? uids.length : uids))).toEqual([50, 10])
    for (const item of [...items.slice(0, 100), ...items.slice(200)]) {
      item.links = [link]
    }
    read = await loadBotItemsList(call, null, WHOLE)
    read = await loadBotItemsList(call, read, MORE)
    // A worker on a row below the first page changes: the whole read reads it too.
    items[229]!.links = [{ ...link, state: 'completed' }]
    asked.length = 0
    read = await loadBotItemsList(call, read, worker)
    expect(asked).toHaveLength(2)
    const deep = read.items.find((item) => item.uid === 'i230')?.links[0]
    expect(deep?.kind === 'dispatch' ? deep.state : null).toBe('completed')
    // Pages still owed by a read stopped for a newer ask count too, and are read once.
    read = await loadBotItemsList(call, read, MORE)
    items[0]!.status = 'needs_you'
    read = await loadBotItemsList(call, read, WHOLE, { waiting: () => true })
    asked.length = 0
    read = await loadBotItemsList(call, read, worker)
    expect(asked).toHaveLength(3)
    expect(read.items.filter(closed)).toHaveLength(150)
  })
})
