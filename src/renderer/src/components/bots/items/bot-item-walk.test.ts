import { expect, it } from 'vitest'
import type { BotItemGroups } from '../../../../../shared/bots/bot-item-groups'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import {
  botItemWalkDrop,
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

it('stops at both ends without wrapping, and a list of one has nowhere to go', () => {
  const walk = botItemWalkOf(groups({ needs_you: ['a', 'b'] }), 0)
  expect(botItemWalkStep(walk, 'a', -1)).toBeNull()
  expect(botItemWalkStep(walk, 'b', 1)).toBeNull()
  const one = botItemWalkOf(groups({ working: ['only'] }), 0)
  expect(one.total).toBe(1)
  expect(botItemWalkStep(one, 'only', 1)).toBeNull()
  expect(botItemWalkStep(one, 'only', -1)).toBeNull()
  expect(botItemWalkStep(one, 'missing', 1)).toBeNull()
})

it('adds a read Closed page once per uid, and ends the walk where the host runs out', () => {
  const walk = { uids: ['a', 'd'], total: 5 }
  const paged = botItemWalkExtend(walk, [item('d'), item('e')], false)
  expect(paged).toEqual({ uids: ['a', 'd', 'e'], total: 5 })
  expect(botItemWalkExtend(paged, [item('f')], true)).toEqual({
    uids: ['a', 'd', 'e', 'f'],
    total: 4
  })
})

it('drops a deleted item and counts one fewer', () => {
  expect(botItemWalkDrop({ uids: ['a', 'b', 'c'], total: 4 }, 'b')).toEqual({
    uids: ['a', 'c'],
    total: 3
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

it('takes no more from a page than the members still unloaded since open', () => {
  const walk = { uids: ['a', 'c1'], total: 3 }
  expect(botItemWalkExtend(walk, [item('c2'), item('c3'), item('c4')], false)).toEqual({
    uids: ['a', 'c1', 'c2'],
    total: 3
  })
  expect(botItemWalkExtend(walk, [item('c1')], false)).toBe(walk)
})
