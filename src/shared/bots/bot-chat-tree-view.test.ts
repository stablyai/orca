import { describe, expect, it } from 'vitest'
import type { BotChatTreeChat, BotChatTreeWorker } from './bot-chat-tree'
import { chatsTabWorkers, orderChatsTab } from './bot-chat-tree-view'

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

function worker(key: string, state: BotChatTreeWorker['state'] = 'done'): BotChatTreeWorker {
  return { key, title: key, state, startedAt: 0 }
}

describe('orderChatsTab', () => {
  it('lists chats with something going first, then the rest, newest first in each, Home and closed included', () => {
    const ordered = orderChatsTab([
      chat('home', { origin: 'home', lastActiveAt: 10 }),
      chat('closed', { closed: true, lastActiveAt: 900 }),
      chat('newest', { lastActiveAt: 800 }),
      chat('worker', { lastActiveAt: 50, running: [worker('w', 'running')], runningTotal: 1 }),
      chat('replying', { live: 'replying', lastActiveAt: 40 }),
      chat('waiting', { live: 'needs-you', lastActiveAt: 60 })
    ])
    expect(ordered.map((c) => c.chatId)).toEqual([
      'waiting',
      'worker',
      'replying',
      'closed',
      'newest',
      'home'
    ])
  })
})

describe('chatsTabWorkers', () => {
  const busy = chat('busy', {
    running: [worker('r1', 'running'), worker('r2', 'needs-you')],
    runningTotal: 2,
    finished: [worker('f1'), worker('f2'), worker('f3'), worker('f4')],
    finishedTotal: 7
  })

  it('shows five, waiting on the owner first, then running, then finished, and counts the rest', () => {
    const { workers, more, read } = chatsTabWorkers(busy, 5)
    expect(workers.map((w) => w.key)).toEqual(['r2', 'r1', 'f1', 'f2', 'f3'])
    expect(more).toBe(4)
    expect(read).toBe(false)
  })

  it('asks the host for more finished workers when the loaded ones fall short of the cap', () => {
    const { workers, more, read } = chatsTabWorkers(busy, 13)
    expect(workers).toHaveLength(6)
    expect(more).toBe(3)
    expect(read).toBe(true)
  })
})
