import { describe, expect, it } from 'vitest'
import { matchBotChats } from './bot-chat-search'
import { botOwnChatTree, type BotChatTreeChat, type BotChatTreeWorker } from './bot-chat-tree'
import { botChatSearchHits, chatsTabWorkers, orderChatsTab } from './bot-chat-tree-view'

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

  it('shows waiting workers first and requests more finished workers only for a larger page', () => {
    const { workers, more, read } = chatsTabWorkers(busy, 5)
    expect(workers.map((w) => w.key)).toEqual(['r2', 'r1', 'f1', 'f2', 'f3'])
    expect(more).toBe(4)
    expect(read).toBe(false)

    const expanded = chatsTabWorkers(busy, 13)
    expect(expanded.workers.map((w) => w.key)).toEqual(['r2', 'r1', 'f1', 'f2', 'f3', 'f4'])
    expect(expanded.more).toBe(3)
    expect(expanded.read).toBe(true)
  })
})

describe('botChatSearchHits', () => {
  const room = chat('bot-group-member-1', {
    title: 'Release room',
    running: [worker('w1', 'needs-you')],
    runningTotal: 1
  })
  // The list's Home: its own page of workers, the room's merged in.
  const [listHome] = botOwnChatTree({
    chats: [
      chat('home', { origin: 'home', running: [worker('listed', 'running')], runningTotal: 1 }),
      room
    ],
    workspaceChats: {}
  }).chats
  const keys = (hit: { chat: BotChatTreeChat } | undefined) =>
    hit ? [...hit.chat.running, ...hit.chat.finished].map((entry) => entry.key) : []

  it("shows the answer's own Home worker the list's page didn't hold", () => {
    const answerHome = chat('home', {
      origin: 'home',
      finished: [worker('worker:old')],
      finishedTotal: 1
    })
    const hits = botChatSearchHits(
      { chats: [answerHome], matches: [{ chatId: 'home', workerKeys: ['worker:old'] }], more: 0 },
      listHome ?? null
    )
    expect(keys(hits[0])).toEqual(['worker:old'])
  })

  it("finds a room's matching worker once, under Home, from the host's answer alone", () => {
    const { matches, more } = matchBotChats(
      [{ chatId: room.chatId, title: 'Release room' }],
      [{ key: 'w1', chatId: room.chatId, title: 'Release notes' }],
      'release'
    )
    const hits = botChatSearchHits({ chats: [room], matches, more }, listHome ?? null)

    expect(hits.map((hit) => hit.chat.chatId)).toEqual(['home'])
    expect(keys(hits[0])).toEqual(['w1'])
    expect(hits[0]?.chat.runningTotal).toBe(1)
  })

  it('lists Home matched by its own words and a room worker as one row, totals from the answer', () => {
    const hits = botChatSearchHits(
      {
        chats: [chat('home', { origin: 'home' }), room],
        matches: [
          { chatId: 'home', workerKeys: null },
          { chatId: room.chatId, workerKeys: ['w1'] }
        ],
        more: 0
      },
      listHome ?? null
    )

    expect(hits.map((hit) => hit.chat.chatId)).toEqual(['home'])
    expect(keys(hits[0])).toEqual(['w1'])
    expect(hits[0]?.chat.runningTotal).toBe(1)
    expect(hits[0]?.matches).toBeNull()
  })
})
