import { describe, expect, it } from 'vitest'
import { botItemsNeedingOwnerByBot } from './bot-item-groups'
import { readBotChangeScope } from './bot-change-scope'

const NOW = 10 * 24 * 60 * 60 * 1000

describe('botItemsNeedingOwnerByBot', () => {
  it("names each bot's newest event by someone else among only the items it counts", () => {
    const { counts, othersLast } = botItemsNeedingOwnerByBot(
      [
        { botId: 'a', lastActivityAt: NOW, snoozedUntil: null, othersLastEventId: 7 },
        { botId: 'a', lastActivityAt: NOW, snoozedUntil: null, othersLastEventId: 12 },
        // Snoozed: not counted, so its newer event says nothing new.
        { botId: 'a', lastActivityAt: NOW, snoozedUntil: NOW + 1000, othersLastEventId: 40 },
        // Stale (five days untouched): not counted either.
        { botId: 'b', lastActivityAt: 0, snoozedUntil: null, othersLastEventId: 30 },
        { botId: 'b', lastActivityAt: NOW, snoozedUntil: null, othersLastEventId: 3 }
      ],
      [{ id: 'a' }, { id: 'b' }],
      NOW
    )
    expect(counts).toEqual({ a: 2, b: 1 })
    expect(othersLast).toEqual({ a: 12, b: 3 })
  })

  it('reads rows without the event as none', () => {
    const { othersLast } = botItemsNeedingOwnerByBot(
      [{ botId: 'a', lastActivityAt: NOW, snoozedUntil: null }],
      [{ id: 'a' }],
      NOW
    )
    expect(othersLast).toEqual({ a: 0 })
  })
})

describe('readBotChangeScope needsYou', () => {
  it('keeps othersLast, and reads a notice from an older host without it', () => {
    const scope = readBotChangeScope({
      kinds: ['items'],
      needsYou: { counts: { a: 1 }, at: 5, othersLast: { a: 9, b: 'x' } }
    })
    expect(scope?.needsYou).toEqual({ counts: { a: 1 }, at: 5, othersLast: { a: 9 } })
    const older = readBotChangeScope({ kinds: ['items'], needsYou: { counts: { a: 1 }, at: 5 } })
    expect(older?.needsYou).toEqual({ counts: { a: 1 }, at: 5 })
  })
})
