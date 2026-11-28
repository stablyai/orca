import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  noteBotItemsSeen,
  readBotItemsSeen,
  resetBotItemsSeenForTest,
  subscribeBotItemsSeen
} from './bot-items-seen'

const bot = { id: 'b1', hostId: 'local' as const }

afterEach(() => resetBotItemsSeenForTest())

describe('bot items seen marks', () => {
  it("reads the higher of the host's mark and this window's", () => {
    expect(readBotItemsSeen({ ...bot, itemsSeen: 5 })).toBe(5)
    noteBotItemsSeen(bot, 'e9')
    expect(readBotItemsSeen({ ...bot, itemsSeen: 5 })).toBe(9)
    expect(readBotItemsSeen({ ...bot, itemsSeen: 20 })).toBe(20)
  })

  it('tells readers only when a mark rises', () => {
    const listener = vi.fn()
    subscribeBotItemsSeen(listener)
    noteBotItemsSeen(bot, 'e9')
    noteBotItemsSeen(bot, 'e4')
    noteBotItemsSeen(bot, 'e9')
    noteBotItemsSeen(bot, 'bad')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
