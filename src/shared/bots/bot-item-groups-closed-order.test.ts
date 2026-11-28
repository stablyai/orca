import { describe, expect, it } from 'vitest'
import { botItemsClosedInTimeOrder } from './bot-item-groups'
import { makeTestBotItem } from './bot-item.test-fixture'

describe('botItemsClosedInTimeOrder', () => {
  it('lists closed items newest first and leaves each bot’s array in place', () => {
    const older = makeTestBotItem(2, { status: 'done', lastActivityAt: 10 })
    const newer = makeTestBotItem(1, { status: 'done', lastActivityAt: 30 })
    const sameTimeHigherNumber = makeTestBotItem(4, { status: 'canceled', lastActivityAt: 30 })
    const firstBot = [older, newer]
    const ordered = botItemsClosedInTimeOrder([
      { closed: firstBot, more: false },
      { closed: [sameTimeHigherNumber], more: false }
    ])
    expect(ordered.map((item) => item.number)).toEqual([4, 1, 2])
    expect(firstBot.map((item) => item.number)).toEqual([2, 1])
  })
})
