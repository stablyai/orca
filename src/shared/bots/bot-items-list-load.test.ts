import { describe, expect, it } from 'vitest'
import { makeTestBotItem } from './bot-item.test-fixture'
import type { BotItem } from './bot-items'
import type { BotItemsListRead } from './bot-item-schema'
import { loadBotItemsList, type BotItemsListCall } from './bot-items-list-load'
import { BOT_ITEMS_WORKER_LINKED } from './bot-items-notice-parts'

const closed = (item: BotItem) => item.status === 'done' || item.status === 'canceled'
const order = (a: BotItem, b: BotItem) => b.lastActivityAt - a.lastActivityAt || b.number - a.number

/** A host's list call over these items, as `bots.items.owner.list` pages them; `older` ignores the
 *  params a host before them doesn't know (it answers every open item and one Closed page). */
function host(items: BotItem[], older = false): BotItemsListCall {
  return async (params) => {
    const read = structuredClone(answer(items, older, params))
    return older ? read : { ...read, items: read.items.map((item) => ({ ...item, summary: true })) }
  }
}

function answer(
  items: BotItem[],
  older: boolean,
  params: Record<string, unknown>
): BotItemsListRead {
  const counts: Partial<Record<BotItem['status'], number>> = {}
  items.forEach((item) => (counts[item.status] = (counts[item.status] ?? 0) + 1))
  if (!older && Array.isArray(params.uids)) {
    const uids = new Set(params.uids)
    return { items: items.filter((item) => uids.has(item.uid)), counts, seenEventId: 'e0' }
  }
  const size = !older && typeof params.closedLimit === 'number' ? params.closedLimit : 50
  const [at, number] = String(params.closedCursor ?? '')
    .split(':')
    .map(Number)
  const after = (item: BotItem) =>
    typeof params.closedCursor !== 'string' ||
    item.lastActivityAt < at! ||
    (item.lastActivityAt === at && item.number < number!)
  const open = !older && params.closedOnly ? [] : items.filter((item) => !closed(item))
  const rest = items.filter((item) => closed(item) && after(item)).sort(order)
  const page = rest.slice(0, size)
  const end = page.at(-1)
  return {
    items: [...open.sort(order), ...page],
    counts,
    seenEventId: 'e0',
    ...(rest.length > size && end
      ? { nextClosedCursor: `${end.lastActivityAt}:${end.number}` }
      : {})
  }
}

function seeded(): BotItem[] {
  return Array.from({ length: 300 }, (_, index) =>
    makeTestBotItem(index + 1, {
      uid: `i${index + 1}`,
      status: index < 100 ? 'working' : 'done',
      lastActivityAt: index + 1
    })
  )
}

const WHOLE = { whole: true, parts: [], more: false }
const MORE = { whole: false, parts: [], more: true }

async function drain(call: BotItemsListCall, read: BotItemsListRead): Promise<BotItemsListRead> {
  let value = read
  while (value.nextClosedCursor) {
    value = await loadBotItemsList(call, value, MORE)
  }
  return value
}

describe('loadBotItemsList', () => {
  it('reaches every Closed item once through Show more after named changes at the loaded edge', async () => {
    const items = seeded()
    const call = host(items)
    let read = await loadBotItemsList(call, null, WHOLE)
    read = await loadBotItemsList(call, read, MORE)
    expect(read.items.filter(closed)).toHaveLength(100)

    // 60 open items close at once, and a loaded Closed one reopens.
    const changed: string[] = []
    for (const item of items.slice(0, 60)) {
      Object.assign(item, { status: 'done', lastActivityAt: 1000 + item.number, version: 2 })
      changed.push(item.uid)
    }
    Object.assign(items[250]!, { status: 'working', lastActivityAt: 2000, version: 2 })
    changed.push('i251')
    read = await loadBotItemsList(call, read, { whole: false, parts: changed, more: false })
    // No deeper than loaded: the rows pushed past the end wait behind Show more.
    expect(read.items.filter(closed)).toHaveLength(100)

    read = await drain(call, read)
    const uids = read.items.filter(closed).map((item) => item.uid)
    expect(uids).toHaveLength(259)
    expect(new Set(uids).size).toBe(259)
    expect(read.items.filter((item) => !closed(item))).toHaveLength(41)

    // Read to its end, a list keeps room for the pages it took, on a named read and a whole one.
    Object.assign(items[60]!, { status: 'done', lastActivityAt: 3000, version: 2 })
    read = await loadBotItemsList(call, read, { whole: false, parts: ['i61'], more: false })
    expect(read.items.filter(closed)).toHaveLength(260)
    expect(read.nextClosedCursor).toBeUndefined()
    for (const item of items.slice(61, 81)) {
      Object.assign(item, { status: 'done', lastActivityAt: 4000 + item.number, version: 2 })
    }
    read = await loadBotItemsList(call, read, WHOLE)
    expect(read.items.filter(closed)).toHaveLength(280)
  })

  it('keeps a first page read to its end to one page as more items close', async () => {
    const items = seeded().slice(98, 149)
    const call = host(items)
    let read = await loadBotItemsList(call, null, WHOLE)
    expect(read.nextClosedCursor).toBeUndefined()
    for (const item of items.filter((entry) => !closed(entry))) {
      Object.assign(item, { status: 'done', lastActivityAt: 1000 + item.number, version: 2 })
    }
    read = await loadBotItemsList(call, read, { whole: false, parts: ['i99', 'i100'], more: false })
    expect(read.items.filter(closed)).toHaveLength(50)
    expect(read.nextClosedCursor).toBeDefined()
  })

  it('reads the loaded depth again on a whole read, page by page from an older host', async () => {
    const items = seeded()
    for (const older of [false, true]) {
      const limits: unknown[] = []
      const call: BotItemsListCall = (params) => {
        limits.push(params.closedLimit)
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
      // The chat-filtered list reads its loaded pages again, as it always did.
      calls = 0
      await loadBotItemsList(counted, read, WHOLE, { pageUnmoved: true })
      expect(calls).toBe(2)
    }
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
    await loadBotItemsList(counted, read, WHOLE, { live: () => calls === 0 })
    expect(calls).toBe(1)
  })

  it('reads the loaded items that link a worker for a worker change, a hundred a read', async () => {
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
    // More than one read holds: a read per hundred, however deep Closed is loaded.
    for (const item of [...items.slice(0, 100), ...items.slice(200)]) {
      item.links = [link]
    }
    read = await loadBotItemsList(call, null, WHOLE)
    read = await loadBotItemsList(call, read, MORE)
    asked.length = 0
    await loadBotItemsList(call, read, worker)
    expect(asked.map((uids) => (Array.isArray(uids) ? uids.length : uids))).toEqual([100, 100])
  })

  it('keeps loaded Closed items when an older host answers a named read whole', async () => {
    const items = seeded()
    const call = host(items, true)
    let read = await loadBotItemsList(call, null, WHOLE)
    read = await loadBotItemsList(call, read, MORE)
    // A loaded row on the second page, named (as a worker change names linked items).
    read = await loadBotItemsList(call, read, { whole: false, parts: ['i220'], more: false })
    expect(read.items.filter(closed)).toHaveLength(100)
    expect(read.items.some((item) => item.uid === 'i220')).toBe(true)
    // Every loaded Closed item named: its first page holds only asked ones, yet isn't all of them.
    const loaded = read.items.filter(closed).map((item) => item.uid)
    read = await loadBotItemsList(call, read, { whole: false, parts: loaded, more: false })
    expect(read.items.filter(closed)).toHaveLength(100)
  })
})
