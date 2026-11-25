// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest'
import type { Bot } from '../../../shared/bot-types'
import { publishBots, setBotHostListing } from './bot-catalog-snapshot'
import { readBotsNeedingOwner } from './bots-needing-owner'

function bot(id: string, hostId: string): Bot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only a bot's id and host; the rest of a bot is irrelevant here.
  return { id, name: id, hostId } as unknown as Bot
}

const answer = (needsYou?: Record<string, number>) => ({
  threadReplies: false,
  webhooks: undefined,
  ...(needsYou ? { needsYou } : {})
})

beforeEach(() => {
  setBotHostListing({
    hosts: [
      { hostId: 'local', state: 'live' },
      { hostId: 'runtime:env-1', state: 'live' }
    ],
    updateNeeded: []
  })
  // The snapshot is module state: start each test with both hosts listing no bots.
  publishBots([], answer({}))
  publishBots([], answer({}), 'runtime:env-1')
})

it('lists only bots with Needs you items, plus bots on a host that does not count them', () => {
  publishBots([bot('a', 'local'), bot('b', 'local'), bot('c', 'local')], answer({ a: 2, c: 1 }))
  // An older server sends no counts: its bot may have items, so the inbox reads it.
  publishBots([bot('d', 'runtime:env-1')], answer(), 'runtime:env-1')
  const read = readBotsNeedingOwner()
  expect(read.bots.map((entry) => entry.id)).toEqual(['a', 'c', 'd'])
  // Only counted items add to the total.
  expect(read.total).toBe(3)
})

it('returns the same value while nothing changed, and a new one when a count does', () => {
  publishBots([bot('a', 'local'), bot('b', 'local')], answer({ a: 1, b: 1 }))
  const first = readBotsNeedingOwner()
  expect(readBotsNeedingOwner()).toBe(first)
  publishBots([bot('a', 'local'), bot('b', 'local')], answer({ a: 1, b: 0 }))
  const next = readBotsNeedingOwner()
  expect(next).not.toBe(first)
  expect(next.bots.map((entry) => entry.id)).toEqual(['a'])
  expect(next.total).toBe(1)
})

it('reads as empty when no bot needs the owner', () => {
  publishBots([bot('a', 'local')], answer({ a: 0 }))
  expect(readBotsNeedingOwner()).toEqual({ bots: [], total: 0 })
})
