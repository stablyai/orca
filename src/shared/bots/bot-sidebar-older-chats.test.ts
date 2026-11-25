import { describe, expect, it } from 'vitest'
import type { BotChatTreeChat, BotChatTreeWorker } from './bot-chat-tree'
import { splitOlderBotSidebarChats } from './bot-sidebar-older-chats'
import { buildBotSidebarTree } from './bot-sidebar-tree'

const NOW = 10 * 24 * 3_600_000
const DAYS_AGO_4 = NOW - 4 * 24 * 3_600_000

const worker = (name: string, state: BotChatTreeWorker['state']): BotChatTreeWorker => ({
  key: name,
  title: name,
  state,
  startedAt: DAYS_AGO_4,
  worktreeId: name
})

function chat(chatId: string, extra: Partial<BotChatTreeChat> = {}): BotChatTreeChat {
  const running = extra.running ?? []
  return {
    chatId,
    title: chatId,
    origin: 'side',
    live: 'idle',
    lastActiveAt: DAYS_AGO_4,
    unread: true,
    closed: false,
    tab: true,
    running,
    runningTotal: running.length,
    finished: [],
    finishedTotal: 0,
    failedTotal: 0,
    ...extra
  }
}

function split(chats: BotChatTreeChat[], workspaceChats: Record<string, string> = {}) {
  const workspaces = Object.keys(workspaceChats).map((id) => ({ id }))
  const view = buildBotSidebarTree({
    chats,
    workspaces,
    workspaceChats,
    foldOf: () => undefined,
    stepsOf: () => 0,
    activeLineId: 'open-line'
  })
  const result = splitOlderBotSidebarChats(view.chats, {
    now: NOW,
    focusedAt: new Map([
      ['focused-today', NOW - 3_600_000],
      ['focused-long-ago', DAYS_AGO_4]
    ]),
    activeChatId: 'in-front',
    liveLineIds: new Set(['live-line']),
    activeLineId: 'open-line'
  })
  return {
    recent: result.recent.map((each) => each.chat.chatId),
    older: result.older.map((each) => each.chat.chatId)
  }
}

describe('splitOlderBotSidebarChats', () => {
  it('folds only settled chats a day old that nothing holds, keeping order', () => {
    const chats = [
      chat('home', { origin: 'home' }),
      chat('failed-1'),
      chat('needs-you', { live: 'needs-you' }),
      chat('replying', { live: 'replying' }),
      chat('running-worker', { running: [worker('w-run', 'running')] }),
      chat('asking-worker', { running: [worker('w-ask', 'asking-bot')] }),
      chat('unreachable-worker', { running: [worker('w-gone', 'unreachable')] }),
      chat('fresh-failure', { lastActiveAt: NOW - 3_600_000 }),
      chat('unknown-age', { lastActiveAt: 0 }),
      chat('in-front'),
      chat('focused-today'),
      chat('focused-long-ago'),
      chat('holds-live-line'),
      chat('holds-open-line'),
      chat('failed-2', { unseen: true })
    ]
    expect(
      split(chats, {
        'live-line': 'holds-live-line',
        'open-line': 'holds-open-line',
        'old-done-line': 'failed-1'
      })
    ).toEqual({
      recent: [
        'home',
        'needs-you',
        'replying',
        'running-worker',
        'asking-worker',
        'unreachable-worker',
        'fresh-failure',
        'unknown-age',
        'in-front',
        'focused-today',
        'holds-live-line',
        'holds-open-line'
      ],
      older: ['failed-1', 'focused-long-ago', 'failed-2']
    })
  })

  it('folds nothing when only one chat qualifies', () => {
    expect(split([chat('home', { origin: 'home' }), chat('failed-1')])).toEqual({
      recent: ['home', 'failed-1'],
      older: []
    })
  })
})
