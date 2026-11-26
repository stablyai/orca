import { describe, expect, it } from 'vitest'
import { makeTestBotItem } from './bot-item.test-fixture'
import { BOT_ITEM_GROUP_IDS, filterBotItems, groupBotItems } from './bot-item-groups'
import type { BotItem } from './bot-items'
import { botItemWalkExtend, botItemWalkOf, botItemWalkStep } from './bot-item-walk'

const DAY = 24 * 60 * 60 * 1000
const NOW = 100 * DAY
const STALE_DAYS = 5
const design = { id: 'chat-design', kind: 'chat', title: 'Design' } as const

let next = 1
const item = (fields: Partial<BotItem>): BotItem =>
  makeTestBotItem(next++, { lastActivityAt: NOW - next * 60_000, ...fields })

// Every section holds at least one row; Closed's loaded rows are a few of the host's 40.
const items = [
  item({ status: 'needs_you' }),
  item({ status: 'needs_you', chat: design }),
  item({ status: 'needs_you' }),
  item({ status: 'working' }),
  item({ status: 'working', chat: design }),
  item({ status: 'working' }),
  item({ status: 'waiting' }),
  item({ status: 'planned' }),
  item({ status: 'working', snoozedUntil: NOW + DAY }),
  item({ status: 'planned', snoozedUntil: NOW + 2 * DAY }),
  item({ status: 'working', lastActivityAt: NOW - 9 * DAY }),
  item({ status: 'waiting', lastActivityAt: NOW - 9 * DAY, chat: design }),
  item({ status: 'done' }),
  item({ status: 'canceled', chat: design }),
  item({ status: 'done' })
]
const groups = groupBotItems(items, STALE_DAYS, NOW, 'e10')
const uidsOf = (rows: readonly BotItem[]): string[] => rows.map((row) => row.uid)

describe('botItemWalkOf', () => {
  it('walks only the opened item’s section, in list order, clamped at its ends', () => {
    for (const id of BOT_ITEM_GROUP_IDS) {
      const section = uidsOf(groups[id])
      expect(section.length, id).toBeGreaterThan(0)
      for (const uid of section) {
        const walk = botItemWalkOf(groups, 40, uid)
        expect(walk?.uids, `${id} ${uid}`).toEqual(section)
        // The Closed count's unloaded rows never pad another section.
        expect(walk?.total, `${id} ${uid}`).toBe(id === 'closed' ? 40 : section.length)
      }
      const walk = botItemWalkOf(groups, 40, section[0])!
      expect(botItemWalkStep(walk, section[0], -1)).toBeNull()
      expect(botItemWalkStep(walk, section.at(-1)!, 1)).toEqual(
        id === 'closed' ? { kind: 'page' } : null
      )
    }
    expect(botItemWalkOf(groups, 40, 'uid-unlisted')).toBeNull()
  })

  it('reads unloaded Closed rows into the Closed walk only', () => {
    const closed = uidsOf(groups.closed)
    const page = [
      makeTestBotItem(901, { status: 'done' }),
      makeTestBotItem(902, { status: 'canceled' })
    ]
    const read = botItemWalkExtend(botItemWalkOf(groups, 40, closed[0])!, page, true)
    expect(read).toEqual({ uids: [...closed, 'uid-901', 'uid-902'], total: closed.length + 2 })
    expect(botItemWalkStep(read, closed.at(-1)!, 1)).toEqual({ kind: 'open', uid: 'uid-901' })
    expect(botItemWalkStep(read, 'uid-902', 1)).toBeNull()
  })

  it('counts a filtered section as its header does', () => {
    const filtered = groupBotItems(
      filterBotItems(items, { chatIds: [design.id], botIds: null, needsYou: false }),
      STALE_DAYS,
      NOW,
      'e10'
    )
    // The chat's own read counts 3 Closed on the host; the header shows max(that, loaded).
    const closedUid = filtered.closed[0].uid
    expect(botItemWalkOf(filtered, 3, closedUid)).toEqual({ uids: [closedUid], total: 3 })
    const working = uidsOf(filtered.working)
    expect(botItemWalkOf(filtered, 3, working[0])).toEqual({ uids: working, total: 1 })
    expect(botItemWalkOf(filtered, 3, groups.needs_you[0].uid)).toBeNull()
  })
})
