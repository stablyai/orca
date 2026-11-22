import { describe, expect, it } from 'vitest'
import {
  botChatAutoCloseHolds,
  botChatItemStamp,
  readBotChatAutoCloseView
} from './bot-chat-auto-close'

const counting = { phase: 'counting', closesAt: 5 } as const

describe('botChatAutoCloseHolds', () => {
  it('holds a counting or paused chat in front of a focused window', () => {
    for (const view of [counting, { phase: 'held' } as const]) {
      expect(botChatAutoCloseHolds({ view, visible: true, focused: true, unsent: false })).toBe(
        true
      )
    }
  })

  it('holds a chat with an unsent message even when it is out of sight', () => {
    expect(
      botChatAutoCloseHolds({ view: counting, visible: false, focused: false, unsent: true })
    ).toBe(true)
  })

  it('lets a chat count down behind another tab or an unfocused window', () => {
    expect(
      botChatAutoCloseHolds({ view: counting, visible: false, focused: true, unsent: false })
    ).toBe(false)
    expect(
      botChatAutoCloseHolds({ view: counting, visible: true, focused: false, unsent: false })
    ).toBe(false)
  })

  it('holds nothing when nothing counts down or the chat was kept open', () => {
    for (const view of [null, { phase: 'kept' } as const]) {
      expect(botChatAutoCloseHolds({ view, visible: true, focused: true, unsent: true })).toBe(
        false
      )
    }
  })
})

describe('botChatItemStamp', () => {
  it('changes when an item is added, reopened or closed again', () => {
    const base = botChatItemStamp({ total: 2, open: 0, lastClosedAt: 10 })
    expect(botChatItemStamp({ total: 3, open: 0, lastClosedAt: 10 })).not.toBe(base)
    expect(botChatItemStamp({ total: 2, open: 1, lastClosedAt: 10 })).not.toBe(base)
    expect(botChatItemStamp({ total: 2, open: 0, lastClosedAt: 11 })).not.toBe(base)
    expect(botChatItemStamp({ total: 2, open: 0, lastClosedAt: 10 })).toBe(base)
  })
})

describe('readBotChatAutoCloseView', () => {
  it('reads what a host sends and treats anything else as no countdown', () => {
    expect(readBotChatAutoCloseView(counting)).toEqual(counting)
    expect(readBotChatAutoCloseView({ phase: 'held' })).toEqual({ phase: 'held' })
    expect(readBotChatAutoCloseView({ phase: 'counting' })).toBeNull()
    expect(readBotChatAutoCloseView({ phase: 'later' })).toBeNull()
    expect(readBotChatAutoCloseView(null)).toBeNull()
  })
})
