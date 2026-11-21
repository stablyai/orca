import { describe, expect, it } from 'vitest'
import type { BotItemsListRead } from './bot-item-schema'
import { loadBotItemsList, type BotItemsListCall } from './bot-items-list-load'
import { MORE, WHOLE, closed, host, seeded } from './bot-items-list-load.test-fixture'

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

  it('keeps a fresh first page when a page below it fails', async () => {
    const items = seeded()
    const inner = host(items)
    let read = await loadBotItemsList(inner, null, WHOLE)
    read = await loadBotItemsList(inner, read, MORE)
    Object.assign(items[0]!, { status: 'needs_you', version: 2 })
    const failing: BotItemsListCall = (params) =>
      params.closedCursor ? Promise.reject(new Error('offline')) : inner(params)
    Object.assign(items[299]!, { lastActivityAt: 5000, version: 2 })
    read = await loadBotItemsList(failing, read, WHOLE)
    expect(read.items.find((item) => item.uid === 'i1')?.status).toBe('needs_you')
    expect(read.items.filter(closed)).toHaveLength(50)
    expect(read.nextClosedCursor).toBeDefined()
  })

  it('shows a fresh first page before the pages below it land, and keeps named items if Show more fails', async () => {
    const items = seeded()
    const inner = host(items)
    let read = await loadBotItemsList(inner, null, WHOLE)
    read = await loadBotItemsList(inner, read, MORE)
    Object.assign(items[0]!, { status: 'needs_you', version: 2 })
    const shown: BotItemsListRead[] = []
    let pending: (() => void) | null = null
    const held: BotItemsListCall = (params) =>
      params.closedCursor
        ? new Promise((resolve) => (pending = () => resolve(inner(params))))
        : inner(params)
    const whole = loadBotItemsList(held, read, WHOLE, { show: (value) => shown.push(value) })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(shown[0]?.items.find((item) => item.uid === 'i1')?.status).toBe('needs_you')
    expect(shown[0]?.items.filter(closed)).toHaveLength(100)
    pending!()
    read = await whole
    // A named update with Show more: a failed page keeps the update.
    Object.assign(items[1]!, { status: 'needs_you', version: 2 })
    const failing: BotItemsListCall = (params) =>
      params.closedCursor ? Promise.reject(new Error('offline')) : inner(params)
    read = await loadBotItemsList(failing, read, { whole: false, parts: ['i2'], more: true })
    expect(read.items.find((item) => item.uid === 'i2')?.status).toBe('needs_you')
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
