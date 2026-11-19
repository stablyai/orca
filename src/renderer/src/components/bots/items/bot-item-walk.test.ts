import { expect, it } from 'vitest'
import type { BotItemGroups } from '../../../../../shared/bots/bot-item-groups'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import {
  botItemWalkExtend,
  botItemWalkOf,
  botItemWalkReturnRow,
  botItemWalkStep
} from './bot-item-walk'

const item = (uid: string) => makeTestBotItem(1, { uid })

function groups(rows: Partial<Record<keyof BotItemGroups, string[]>>): BotItemGroups {
  return {
    needs_you: (rows.needs_you ?? []).map(item),
    working: (rows.working ?? []).map(item),
    planned: (rows.planned ?? []).map(item),
    snoozed: (rows.snoozed ?? []).map(item),
    stale: (rows.stale ?? []).map(item),
    closed: (rows.closed ?? []).map(item)
  }
}

it('walks the list in group order, folded groups and unloaded Closed items counted', () => {
  const walk = botItemWalkOf(
    groups({ needs_you: ['a'], working: ['b'], planned: ['c'], closed: ['d'] }),
    3
  )
  expect(walk).toEqual({ uids: ['a', 'b', 'c', 'd'], total: 6 })
  expect(botItemWalkStep(walk, 'b', 1)).toEqual({ kind: 'open', uid: 'c' })
  expect(botItemWalkStep(walk, 'b', -1)).toEqual({ kind: 'open', uid: 'a' })
  expect(botItemWalkStep(walk, 'd', 1)).toEqual({ kind: 'page' })
})

it('deduplicates and caps Closed pages, and ends the walk where the host runs out', () => {
  const walk = { uids: ['a', 'd'], total: 5 }
  const paged = botItemWalkExtend(walk, [item('d'), item('e')], false)
  expect(paged).toEqual({ uids: ['a', 'd', 'e'], total: 5 })
  expect(botItemWalkExtend(paged, [item('e')], false)).toBe(paged)
  expect(botItemWalkExtend(paged, [item('f'), item('g'), item('h')], false)).toEqual({
    uids: ['a', 'd', 'e', 'f', 'g'],
    total: 5
  })
  expect(botItemWalkExtend(paged, [item('f')], true)).toEqual({
    uids: ['a', 'd', 'e', 'f'],
    total: 4
  })
})

it('returns Back to the item’s row, else the nearest listed one after it, then before, then the last', () => {
  const walk = { uids: ['a', 'b', 'c', 'd'], total: 4 }
  expect(botItemWalkReturnRow(walk, 'b', ['a', 'b', 'd'])).toBe('b')
  expect(botItemWalkReturnRow(walk, 'b', ['a', 'd'])).toBe('d')
  expect(botItemWalkReturnRow(walk, 'd', ['a', 'b'])).toBe('b')
  expect(botItemWalkReturnRow(null, 'z', ['a', 'x'])).toBe('x')
  expect(botItemWalkReturnRow(walk, 'b', [])).toBeNull()
})
