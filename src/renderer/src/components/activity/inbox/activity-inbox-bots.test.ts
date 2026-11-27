import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { HostAccessRequest } from '@/lib/bot-access-requests'

const snapshot = vi.hoisted(() => ({
  count: 0 as number | null,
  othersLast: null as number | null,
  hostState: 'live' as string | null
}))

vi.mock('@/lib/bot-catalog-snapshot', () => ({
  readBots: () => [],
  readBotHostState: () => snapshot.hostState,
  readBotItemsNeedingOwner: () => snapshot.count,
  readBotNeedsYouOthersLast: () => snapshot.othersLast
}))

const { botHasNewNeedingYou, nextAccessRequestExpiry } = await import('./activity-inbox')
const { noteBotItemsSeen, resetBotItemsSeenForTest } = await import('@/lib/bot-items-seen')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check reads only these fields.
const bot = (itemsSeen?: number): Bot =>
  ({ id: 'b1', hostId: 'local', paused: false, itemsSeen }) as unknown as Bot

beforeEach(() => {
  snapshot.count = 2
  snapshot.othersLast = 10
  snapshot.hostState = 'live'
  resetBotItemsSeenForTest()
})

describe('botHasNewNeedingYou', () => {
  it("is new while someone else moved an item after the bot's seen mark", () => {
    expect(botHasNewNeedingYou(bot(9))).toBe(true)
    expect(botHasNewNeedingYou(bot(10))).toBe(false)
    // A new event on an item you'd seen shows it again, even with the count unchanged.
    snapshot.othersLast = 11
    expect(botHasNewNeedingYou(bot(10))).toBe(true)
  })

  it("clears at once on this window's own mark, before the bot list re-reads", () => {
    noteBotItemsSeen({ id: 'b1', hostId: 'local' }, 'e10')
    expect(botHasNewNeedingYou(bot(3))).toBe(false)
  })

  it('says nothing with nothing needing you, a paused bot, or an offline host', () => {
    snapshot.count = 0
    expect(botHasNewNeedingYou(bot())).toBe(false)
    snapshot.count = 2
    expect(botHasNewNeedingYou({ ...bot(), paused: true } as Bot)).toBe(false)
    snapshot.hostState = 'offline'
    expect(botHasNewNeedingYou(bot())).toBe(false)
  })

  it("treats an older host's items as to-dos: new until they're answered", () => {
    snapshot.othersLast = null
    expect(botHasNewNeedingYou(bot(1_000))).toBe(true)
  })
})

describe('nextAccessRequestExpiry', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads only expiresAt.
  const request = (expiresAt: number) => ({ expiresAt }) as HostAccessRequest
  it('is the first expiry still ahead', () => {
    expect(nextAccessRequestExpiry([request(50), request(30), request(5)], 10)).toBe(30)
    expect(nextAccessRequestExpiry([request(5)], 10)).toBeNull()
  })
})
