import { describe, expect, it } from 'vitest'
import type { BotChatTreeChat } from './bot-chat-tree'
import {
  BOT_SIDEBAR_OLDER_AFTER_MS,
  botSidebarChatIsOlder,
  splitOlderBotSidebarChats,
  type BotSidebarOlderKeep
} from './bot-sidebar-older-chats'

const NOW = 100 * BOT_SIDEBAR_OLDER_AFTER_MS
const OLD = NOW - BOT_SIDEBAR_OLDER_AFTER_MS

function chat(chatId: string, overrides: Partial<BotChatTreeChat> = {}): BotChatTreeChat {
  return {
    chatId,
    title: chatId,
    origin: 'side',
    live: 'idle',
    lastActiveAt: OLD,
    unread: false,
    closed: false,
    tab: true,
    running: [],
    runningTotal: 0,
    finished: [],
    finishedTotal: 0,
    failedTotal: 0,
    ...overrides
  }
}

function keep(overrides: Partial<BotSidebarOlderKeep> = {}): BotSidebarOlderKeep {
  return {
    now: NOW,
    frontChatId: null,
    focusedAt: () => undefined,
    openChatIds: new Set(),
    activeLineChatIds: new Set(),
    ...overrides
  }
}

describe('botSidebarChatIsOlder', () => {
  it('folds a settled chat with no activity for a day, failed ones included', () => {
    expect(botSidebarChatIsOlder(chat('a'), keep())).toBe(true)
    expect(botSidebarChatIsOlder(chat('failed', { failedTotal: 3 }), keep())).toBe(true)
    expect(botSidebarChatIsOlder(chat('a', { lastActiveAt: OLD + 1 }), keep())).toBe(false)
  })

  it('never folds Home, a replying or waiting chat, one with a worker going, or one with something new', () => {
    for (const overrides of [
      { origin: 'home' as const },
      { live: 'replying' as const },
      { live: 'needs-you' as const },
      { runningTotal: 1 },
      { unread: true },
      { unseen: true as const },
      { lastActiveAt: 0 }
    ]) {
      expect(botSidebarChatIsOlder(chat('a', overrides), keep())).toBe(false)
    }
  })

  it('never folds the chat in front, one focused within the day, one opened, or one holding the open line', () => {
    expect(botSidebarChatIsOlder(chat('a'), keep({ frontChatId: 'a' }))).toBe(false)
    expect(botSidebarChatIsOlder(chat('a'), keep({ focusedAt: () => NOW - 1000 }))).toBe(false)
    expect(botSidebarChatIsOlder(chat('a'), keep({ focusedAt: () => OLD }))).toBe(true)
    expect(botSidebarChatIsOlder(chat('a'), keep({ openChatIds: new Set(['a']) }))).toBe(false)
    expect(botSidebarChatIsOlder(chat('a'), keep({ activeLineChatIds: new Set(['a']) }))).toBe(
      false
    )
  })
})

describe('splitOlderBotSidebarChats', () => {
  const views = (chats: BotChatTreeChat[]) => chats.map((entry) => ({ chat: entry }))
  const ids = (list: { chat: BotChatTreeChat }[]) => list.map((view) => view.chat.chatId)

  it('keeps the given order on both sides', () => {
    const { recent, older } = splitOlderBotSidebarChats(
      views([
        chat('home', { origin: 'home' }),
        chat('old-1'),
        chat('live', { live: 'replying' }),
        chat('old-2'),
        chat('new', { lastActiveAt: NOW - 1 })
      ]),
      keep()
    )
    expect(ids(recent)).toEqual(['home', 'live', 'new'])
    expect(ids(older)).toEqual(['old-1', 'old-2'])
  })

  it('folds nothing for a single older chat', () => {
    const { recent, older } = splitOlderBotSidebarChats(
      views([chat('home', { origin: 'home' }), chat('old-1')]),
      keep()
    )
    expect(ids(recent)).toEqual(['home', 'old-1'])
    expect(older).toEqual([])
  })

  it('holds shown rows where they are, so none folds away under the person', () => {
    const { recent, older } = splitOlderBotSidebarChats(
      views([chat('old-1'), chat('old-2'), chat('old-3')]),
      keep(),
      new Set(['old-1'])
    )
    expect(ids(recent)).toEqual(['old-1'])
    expect(ids(older)).toEqual(['old-2', 'old-3'])
  })
})
