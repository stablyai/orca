import { describe, expect, it } from 'vitest'
import { botItemActivity, botItemWaitEntryKey } from './bot-item-activity'
import { makeTestBotItem } from './bot-item.test-fixture'
import type { BotItemEvent } from './bot-items'

const actor = { kind: 'bot' as const, botId: 'bot-a', chatId: 'chat-home' }
const moved = (id: string, to: string): BotItemEvent => ({
  id,
  kind: 'status',
  actor,
  data: { from: 'working', to, note: 'CI on #9' },
  at: 1
})
const comment: BotItemEvent = {
  id: 'e3',
  kind: 'commented',
  actor,
  data: { text: 'Still red' },
  at: 2
}

describe('the move a Waiting item’s card stands for', () => {
  const waiting = makeTestBotItem(4, { status: 'waiting', wait: { text: 'CI on #9', at: 1 } })

  it('is its latest status event while that set Waiting, comments after it included', () => {
    const events = [moved('e1', 'working'), moved('e2', 'waiting'), comment]
    const entries = botItemActivity(waiting, events)
    expect(botItemWaitEntryKey(waiting, entries)).toBe(
      entries.find((entry) => entry.kind === 'event' && entry.event.id === 'e2')!.key
    )
  })

  it('is none once the item moved on, or when the move is past the loaded page', () => {
    const working = makeTestBotItem(4)
    const events = [moved('e2', 'waiting'), moved('e5', 'working')]
    expect(botItemWaitEntryKey(working, botItemActivity(working, events))).toBeNull()
    expect(botItemWaitEntryKey(waiting, botItemActivity(waiting, [comment]))).toBeNull()
  })
})
