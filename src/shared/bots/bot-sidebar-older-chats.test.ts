import { describe, expect, it } from 'vitest'
import type { BotChatTreeChat, BotChatTreeWorker } from './bot-chat-tree'
import { splitOlderBotSidebarChats } from './bot-sidebar-older-chats'
import { buildBotSidebarTree } from './bot-sidebar-tree'

const HOUR = 3_600_000
const NOW = 240 * HOUR
const DAYS_AGO_4 = NOW - 96 * HOUR

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

// Workspaces in list order, by the chat each sits under; children nest under 'parent-line'.
const WORKSPACE_CHATS: Record<string, string> = {
  'old-done-line': 'failed-1',
  'host-live-line': 'holds-host-live-line',
  'open-line': 'holds-open-line',
  'parent-line': 'holds-asking-descendant',
  'quiet-1': 'holds-paged-out-line',
  'quiet-2': 'holds-paged-out-line',
  'quiet-3': 'holds-paged-out-line',
  'asking-paged-out': 'holds-paged-out-line'
}
const CHILDREN: Record<string, { id: string }[]> = {
  'parent-line': [{ id: 'quiet-child' }, { id: 'middle' }],
  middle: [{ id: 'asking-grandchild' }, { id: 'parent-line' }]
}

function split(chats: BotChatTreeChat[], keepFoldedOnly: ReadonlySet<string> | null = null) {
  const workspaces = Object.keys(WORKSPACE_CHATS).map((id) => ({ id }))
  const view = buildBotSidebarTree({
    chats,
    workspaces,
    workspaceChats: WORKSPACE_CHATS,
    foldOf: () => undefined,
    stepsOf: () => 0,
    activeLineId: 'open-line'
  })
  const result = splitOlderBotSidebarChats(view.chats, {
    now: NOW,
    focusedAt: new Map([
      ['focused-today', NOW - HOUR],
      ['focused-long-ago', DAYS_AGO_4],
      ['cleared-into-session', NOW - HOUR]
    ]),
    heldSessionIds: new Set(['front-session', 'revealed']),
    changedAt: new Map([
      ['changed-today', NOW - HOUR],
      ['changed-long-ago', DAYS_AGO_4]
    ]),
    heldLineIds: new Set(['host-live-line', 'open-line', 'asking-grandchild', 'asking-paged-out']),
    workspaces,
    workspaceChats: WORKSPACE_CHATS,
    childrenOf: (line) => CHILDREN[line.id] ?? [],
    keepFoldedOnly
  })
  return {
    recent: result.recent.map((each) => each.chat.chatId),
    older: result.older.map((each) => each.chat.chatId)
  }
}

const CHATS = [
  chat('home', { origin: 'home' }),
  chat('failed-1'),
  chat('needs-you', { live: 'needs-you' }),
  chat('replying', { live: 'replying' }),
  chat('running-worker', { running: [worker('w-run', 'running')] }),
  chat('asking-worker', { running: [worker('w-ask', 'asking-bot')] }),
  chat('unreachable-worker', { running: [worker('w-gone', 'unreachable')] }),
  chat('fresh-failure', { lastActiveAt: NOW - HOUR }),
  chat('unknown-age', { lastActiveAt: 0 }),
  chat('in-front', { liveSessionId: 'front-session' }),
  chat('revealed'),
  chat('focused-today'),
  chat('focused-long-ago'),
  chat('focused-after-clear', { liveSessionId: 'cleared-into-session' }),
  chat('holds-host-live-line'),
  chat('holds-open-line'),
  chat('holds-asking-descendant'),
  chat('holds-paged-out-line'),
  chat('turn-failed-today', { turnDone: { paneKey: 'p', at: NOW - 60_000 } }),
  chat('worker-failed-today', {
    finished: [{ ...worker('w-failed', 'failed'), settledAt: NOW - 60_000 }]
  }),
  chat('changed-today'),
  chat('changed-long-ago'),
  chat('failed-2', { unseen: true })
]

const HELD = [
  'home',
  'needs-you',
  'replying',
  'running-worker',
  'asking-worker',
  'unreachable-worker',
  'fresh-failure',
  'unknown-age',
  'in-front',
  'revealed',
  'focused-today',
  'focused-after-clear',
  'holds-host-live-line',
  'holds-open-line',
  'holds-asking-descendant',
  'holds-paged-out-line',
  'turn-failed-today',
  'worker-failed-today',
  'changed-today'
]

describe('splitOlderBotSidebarChats', () => {
  it('folds only settled chats a day old that nothing holds, keeping order', () => {
    expect(split(CHATS)).toEqual({
      recent: HELD,
      older: ['failed-1', 'focused-long-ago', 'changed-long-ago', 'failed-2']
    })
  })

  it('folds nothing new while held to the folds already shown', () => {
    expect(split(CHATS, new Set(['failed-1', 'needs-you']))).toEqual({
      recent: CHATS.map((each) => each.chatId).filter((id) => id !== 'failed-1'),
      older: ['failed-1']
    })
  })
})
