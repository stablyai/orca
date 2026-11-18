import { describe, expect, it } from 'vitest'
import {
  chatFoldSummary,
  chatIsGoing,
  normalizeBotChatFolds,
  orderBotChats,
  withBotChatFold,
  type BotChatTreeChat
} from './bot-chat-tree'

function chat(chatId: string, patch: Partial<BotChatTreeChat> = {}): BotChatTreeChat {
  return {
    chatId,
    title: chatId,
    origin: 'side',
    live: 'idle',
    lastActiveAt: 0,
    unread: false,
    closed: false,
    running: [],
    runningTotal: 0,
    finished: [],
    finishedTotal: 0,
    failedTotal: 0,
    ...patch
  }
}

describe('orderBotChats', () => {
  it('pins Home, then waiting on the owner, replying, newest, and closed last', () => {
    const ordered = orderBotChats([
      chat('closed', { closed: true, lastActiveAt: 900 }),
      chat('newest', { lastActiveAt: 800 }),
      chat('older', { lastActiveAt: 100 }),
      chat('running', {
        lastActiveAt: 50,
        runningTotal: 1,
        running: [{ key: 'w1', title: 'w', state: 'running', startedAt: 1 }]
      }),
      chat('replying', { live: 'replying', lastActiveAt: 40 }),
      chat('worker-needs-you', {
        lastActiveAt: 20,
        runningTotal: 1,
        running: [{ key: 'w2', title: 'w', state: 'needs-you', startedAt: 1 }]
      }),
      chat('needs-you', { live: 'needs-you', lastActiveAt: 30 }),
      chat('home', { origin: 'home', lastActiveAt: 10 })
    ])
    expect(ordered.map((row) => row.chatId)).toEqual([
      'home',
      'needs-you',
      'worker-needs-you',
      'replying',
      'newest',
      'older',
      'running',
      'closed'
    ])
  })
})

describe('chatIsGoing', () => {
  it('is going while a chat replies, waits on the owner or has running workers', () => {
    expect(chatIsGoing(chat('a'))).toBe(false)
    expect(chatIsGoing(chat('a', { finishedTotal: 3 }))).toBe(false)
    expect(chatIsGoing(chat('a', { live: 'replying' }))).toBe(true)
    expect(chatIsGoing(chat('a', { live: 'needs-you' }))).toBe(true)
    expect(chatIsGoing(chat('a', { runningTotal: 2 }))).toBe(true)
  })
})

describe('chatFoldSummary', () => {
  it('counts only live workers, never lifetime totals, and is empty when nothing runs', () => {
    const worker = (state: 'running' | 'needs-you') => ({
      key: state,
      title: '',
      state,
      startedAt: 0
    })
    expect(chatFoldSummary(chat('a', { finishedTotal: 799, failedTotal: 25 }))).toBeNull()
    expect(
      chatFoldSummary(
        chat('a', {
          running: [worker('needs-you'), worker('running'), worker('running')],
          runningTotal: 3,
          finishedTotal: 11
        })
      )
    ).toBe('1 waiting · 2 running')
    expect(chatFoldSummary(chat('a', { running: [worker('running')], runningTotal: 1 }))).toBe(
      '1 running'
    )
  })
})

describe('withBotChatFold', () => {
  it('sets, replaces and clears one chat, keeping the newest 500', () => {
    expect(withBotChatFold({ a: 'open' }, 'a', 'folded')).toEqual({ a: 'folded' })
    expect(withBotChatFold({ a: 'open', b: 'open' }, 'a', null)).toEqual({ b: 'open' })
    const many = Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`k${index}`, 'open' as const])
    )
    const next = withBotChatFold(many, 'new', 'folded')
    expect(Object.keys(next)).toHaveLength(500)
    expect(next.k0).toBeUndefined()
    expect(next.new).toBe('folded')
  })

  it('drops unknown persisted values', () => {
    expect(normalizeBotChatFolds({ a: 'open', b: 'sideways', c: 'folded' })).toEqual({
      a: 'open',
      c: 'folded'
    })
    expect(normalizeBotChatFolds(['open'])).toEqual({})
  })
})
