// A host's list call over seeded items, as `bots.items.owner.list` pages them, for the list loader's tests.
import { makeTestBotItem } from './bot-item.test-fixture'
import type { BotItem } from './bot-items'
import type { BotItemsListRead } from './bot-item-schema'
import type { BotItemsListCall } from './bot-items-list-load'

export const closed = (item: BotItem) => item.status === 'done' || item.status === 'canceled'
const order = (a: BotItem, b: BotItem) => b.lastActivityAt - a.lastActivityAt || b.number - a.number

/** A host's list call over these items, as `bots.items.owner.list` pages them; `older` ignores the
 *  params a host before them doesn't know (it answers every open item and one Closed page). */
export function host(items: BotItem[], older = false): BotItemsListCall {
  return async (params) => structuredClone(answer(items, older, params))
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

export function seeded(): BotItem[] {
  return Array.from({ length: 300 }, (_, index) =>
    makeTestBotItem(index + 1, {
      uid: `i${index + 1}`,
      status: index < 100 ? 'working' : 'done',
      lastActivityAt: index + 1
    })
  )
}

export const WHOLE = { whole: true, parts: [], more: false }
export const MORE = { whole: false, parts: [], more: true }
