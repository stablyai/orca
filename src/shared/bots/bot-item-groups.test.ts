import { describe, expect, it } from 'vitest'
import { makeTestBotItem } from './bot-item.test-fixture'
import type { BotItem } from './bot-items'
import {
  botItemsByDispatch,
  botItemsClosedInTimeOrder,
  botItemsNeedingOwner,
  botItemsNeedingOwnerByBot,
  botNeedChat,
  filterBotItems,
  filterBotNeeds,
  groupBotItems,
  groupBotsItems,
  type BotItemFilter
} from './bot-item-groups'
import type { BotNeed } from './bot-now'

const DAY = 24 * 60 * 60_000
const NOW = 100 * DAY

function item(number: number, fields: Partial<BotItem>): BotItem {
  return makeTestBotItem(number, { lastActivityAt: NOW, updatedAt: NOW, ...fields })
}

describe('bot item groups', () => {
  it('groups by status, with stale open items in Stale and both closed statuses in Closed', () => {
    const items = [
      item(1, { status: 'needs_you', lastActivityAt: NOW - 4 * DAY }),
      item(2, { status: 'needs_you', lastActivityAt: NOW - 5 * DAY }),
      item(3, { status: 'planned', lastActivityAt: NOW - 14 * DAY }),
      item(4, { status: 'done' }),
      item(5, { status: 'canceled', lastActivityAt: NOW - 1 })
    ]

    const groups = groupBotItems(items, 5, NOW, 'e10')

    expect(groups.needs_you.map((entry) => entry.number)).toEqual([1])
    expect(groups.stale.map((entry) => entry.number)).toEqual([2])
    expect(groups.planned.map((entry) => entry.number)).toEqual([3])
    expect(groups.closed.map((entry) => entry.number)).toEqual([4, 5])
    expect(botItemsNeedingOwner(items, 5, NOW)).toBe(1)
    expect(botItemsNeedingOwner(items, null, NOW)).toBe(2)
  })

  it('lists rows others changed since the tab was last opened first, then the latest change', () => {
    const items = [
      item(1, { lastActivityAt: NOW - 1_000 }),
      item(2, { lastActivityAt: NOW - 5_000, lastEventId: 'e12', othersLastEventId: 'e12' }),
      item(3, { lastActivityAt: NOW - 500 }),
      // The owner's own change since: not unseen.
      item(4, { lastActivityAt: NOW - 9_000, lastEventId: 'e14', othersLastEventId: 'e8' })
    ]

    expect(groupBotItems(items, 5, NOW, 'e10').working.map((entry) => entry.number)).toEqual([
      2, 3, 1, 4
    ])
  })

  it("merges several bots' items, each read by its own bot's seen mark and stale setting", () => {
    const ana = [
      item(1, { uid: 'a1', lastActivityAt: NOW - 1_000, othersLastEventId: 'e12' }),
      item(2, { uid: 'a2', lastActivityAt: NOW - 4 * DAY })
    ]
    const bo = [
      item(1, { uid: 'b1', lastActivityAt: NOW - 500, othersLastEventId: 'e12' }),
      item(2, { uid: 'b2', lastActivityAt: NOW - 4 * DAY })
    ]

    const groups = groupBotsItems(
      [
        { items: ana, staleDays: 3, seenEventId: 'e5' },
        { items: bo, staleDays: null, seenEventId: 'e20' }
      ],
      NOW
    )

    // Ana's #1 changed since Ana's mark; Bo's #1 is newer but seen by Bo's.
    expect(groups.working.map((entry) => entry.uid)).toEqual(['a1', 'b1', 'b2'])
    expect(groups.stale.map((entry) => entry.uid)).toEqual(['a2'])
  })

  it("lists several bots' Closed items newest first, holding back what a bot's next page may outdate", () => {
    const closed = (uid: string, at: number) =>
      item(1, { uid, status: 'done', lastActivityAt: NOW - at })
    const ana = [closed('a1', 10), closed('a2', 30)]
    const bo = [closed('b1', 20), closed('b2', 50), closed('b3', 60)]
    const uids = (more: boolean) =>
      botItemsClosedInTimeOrder([
        { closed: ana, more },
        { closed: bo, more: false }
      ]).map((entry) => entry.uid)

    // Ana's next page may hold items between 30 and 50 ago, so Bo's older ones wait for it.
    expect(uids(true)).toEqual(['a1', 'b1', 'a2'])
    expect(uids(false)).toEqual(['a1', 'b1', 'a2', 'b2', 'b3'])
  })

  it('holds snoozed items in Snoozed, soonest back first, out of the count, until they come back', () => {
    const items = [
      item(1, { status: 'needs_you', snoozedUntil: NOW + 2 * DAY }),
      item(2, { status: 'planned', snoozedUntil: NOW + DAY }),
      item(3, { status: 'needs_you' }),
      // Back an hour ago after a 10-day snooze: fresh from its wake, so neither stale nor below #3.
      item(4, {
        status: 'needs_you',
        lastActivityAt: NOW - 10 * DAY,
        snoozedUntil: NOW - 3_600_000
      })
    ]

    const groups = groupBotItems(items, 5, NOW, 'e10')

    expect(groups.snoozed.map((entry) => entry.number)).toEqual([2, 1])
    expect(groups.needs_you.map((entry) => entry.number)).toEqual([3, 4])
    expect(groups.stale).toEqual([])
    expect(botItemsNeedingOwner(items, 5, NOW)).toBe(2)
    expect(
      botItemsNeedingOwnerByBot(
        [
          { botId: 'a', lastActivityAt: NOW, snoozedUntil: NOW + 2 * DAY },
          { botId: 'a', lastActivityAt: NOW - 4 * DAY, snoozedUntil: null }
        ],
        [{ id: 'a' }],
        NOW
      )
    ).toEqual({ counts: { a: 1 }, staleInMs: DAY })
  })

  it('filters by chat and Needs you together', () => {
    const items = [
      item(1, { status: 'needs_you' }),
      item(2, { status: 'needs_you', chat: { id: 'side', kind: 'chat', title: 'Side' } }),
      item(3, {})
    ]

    expect(
      filterBotItems(items, { chatIds: ['chat-home'], botIds: null, needsYou: true }).map(
        (i) => i.number
      )
    ).toEqual([1])
    expect(filterBotItems(items, { chatIds: null, botIds: null, needsYou: false })).toHaveLength(3)
  })
})

describe('Orca’s asks under the items filter', () => {
  const linked = item(7, {
    chat: { id: 'side-1', kind: 'chat', title: 'Release notes' },
    links: [
      {
        kind: 'dispatch',
        ref: 'd-first',
        latest: 'd-follow-up',
        title: null,
        state: 'working',
        host: null,
        startedAt: null,
        settledAt: null,
        report: null,
        pr: null
      }
    ]
  })
  const byDispatch = botItemsByDispatch([linked])
  const itemOf = (id: string) => byDispatch.get(id) ?? null
  const worker = (dispatchId: string, origin: 'chat' | 'session'): BotNeed<unknown, unknown> => ({
    kind: 'session',
    key: `worker:${dispatchId}`,
    row: {
      kind: 'worker',
      key: `worker:${dispatchId}`,
      dispatchId,
      title: dispatchId,
      dot: 'permission',
      origin: origin === 'chat' ? { kind: 'chat' } : { kind: 'session', label: 'x' },
      paneKey: null,
      workspaceId: null,
      at: 1,
      worker: null
    }
  })
  const needs: BotNeed<unknown, unknown>[] = [
    { kind: 'chat', key: 'chat' },
    worker('d-follow-up', 'chat'),
    worker('d-home', 'chat'),
    worker('d-side', 'session'),
    { kind: 'side-chat', key: 'side-chat:side-1', sessionId: 'side-1', title: 'Release notes' },
    { kind: 'connector', key: 'connector:github', connector: {} }
  ]
  const keys = (filter: BotItemFilter) =>
    filterBotNeeds(needs, filter, (need) => botNeedChat(need, 'home', itemOf)).map((n) => n.key)

  it('keeps a chat’s own ask and its workers’, by the item a worker’s newest Dispatch links', () => {
    expect(keys({ chatIds: ['side-1'], botIds: null, needsYou: false })).toEqual([
      'worker:d-follow-up',
      'side-chat:side-1'
    ])
    expect(keys({ chatIds: ['home'], botIds: null, needsYou: false })).toEqual([
      'chat',
      'worker:d-home'
    ])
  })

  it('shows a sign-in only unfiltered or with Needs you only', () => {
    expect(keys({ chatIds: null, botIds: null, needsYou: true })).toContain('connector:github')
    expect(keys({ chatIds: ['home'], botIds: null, needsYou: true })).not.toContain(
      'connector:github'
    )
  })
})
