import { describe, expect, it } from 'vitest'
import {
  chatFoldCounts,
  chatFoldSummary,
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

describe('chatFoldSummary', () => {
  const worker = (key: string, state: 'running' | 'needs-you' | 'unreachable') => ({
    key,
    title: key,
    state,
    startedAt: 1
  })

  it('counts waiting and running workers, and none while nothing runs', () => {
    const running = [worker('a', 'needs-you'), worker('b', 'running'), worker('c', 'unreachable')]
    expect(chatFoldCounts(chat('c', { running, runningTotal: 4 }))).toEqual({
      waiting: 1,
      running: 2
    })
    expect(chatFoldCounts(chat('idle'))).toBeNull()
  })

  it("says the counts through the reader's translations, dropping a zero", () => {
    const t = (key: string, fallback: string, values?: Record<string, unknown>): string =>
      `${key}:${fallback.replace('{{count}}', String(values?.count))}`
    expect(chatFoldSummary(t, { waiting: 1, running: 3 })).toBe(
      'bots.chats.waitingCount:1 waiting · bots.chats.runningCount:3 running'
    )
    expect(chatFoldSummary(t, { waiting: 0, running: 2 })).toBe('bots.chats.runningCount:2 running')
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
