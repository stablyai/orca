import { describe, expect, it } from 'vitest'
import type { BotChatTreeChat, BotChatTreeWorker } from './bot-chat-tree'
import {
  botSidebarChatFoldTimes,
  OLDER_BOT_CHAT_AGE_MS,
  splitOlderBotSidebarChats
} from './bot-sidebar-older-chats'
import { buildBotSidebarTree } from './bot-sidebar-tree'

const HOUR = 3_600_000
const NOW = 240 * HOUR
const DAYS_AGO_4 = NOW - 96 * HOUR

type Line = { id: string; host: string }

const worker = (
  name: string,
  state: BotChatTreeWorker['state'],
  settledAt?: number
): BotChatTreeWorker => ({
  key: name,
  title: name,
  state,
  startedAt: DAYS_AGO_4,
  worktreeId: name,
  ...(settledAt === undefined ? {} : { settledAt })
})

function chat(chatId: string, extra: Partial<BotChatTreeChat> = {}): BotChatTreeChat {
  const running = extra.running ?? []
  const finished = extra.finished ?? []
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
    finished,
    finishedTotal: finished.length,
    failedTotal: 0,
    ...extra
  }
}

// Workspaces in list order, by the chat each sits under. Two hosts publish 'twin': only the remote
// one has a descendant waiting on the owner.
const WORKSPACES: Line[] = [
  { id: 'old-done-line', host: 'local' },
  { id: 'host-live-line', host: 'local' },
  { id: 'open-line', host: 'local' },
  { id: 'parent-line', host: 'local' },
  { id: 'quiet-1', host: 'local' },
  { id: 'quiet-2', host: 'local' },
  { id: 'asking-paged-out', host: 'local' },
  { id: 'twin', host: 'local' },
  { id: 'twin', host: 'remote' },
  { id: 'idle-twin', host: 'local' },
  { id: 'idle-twin', host: 'remote' }
]
const WORKSPACE_CHATS: Record<string, string> = {
  'old-done-line': 'failed-1',
  'host-live-line': 'holds-host-live-line',
  'open-line': 'holds-open-line',
  'parent-line': 'holds-asking-descendant',
  'quiet-1': 'holds-paged-out-line',
  'quiet-2': 'holds-paged-out-line',
  'asking-paged-out': 'holds-paged-out-line',
  twin: 'holds-remote-twin-descendant',
  // Two physical workspaces share this id: which chat each belongs to can't be told, so it holds.
  'idle-twin': 'holds-ambiguous-twins'
}
const identityOf = (line: Line): string => `${line.host}/${line.id}`
const CHILDREN: Record<string, Line[]> = {
  'local/parent-line': [
    { id: 'quiet-child', host: 'local' },
    { id: 'middle', host: 'local' }
  ],
  'local/middle': [
    { id: 'asking-grandchild', host: 'local' },
    { id: 'parent-line', host: 'local' }
  ],
  'remote/twin': [{ id: 'twin-asking-child', host: 'remote' }]
}

function split(
  chats: BotChatTreeChat[],
  options: { now?: number; keepFoldedOnly?: ReadonlySet<string> | null } = {}
) {
  const view = buildBotSidebarTree({
    chats,
    workspaces: WORKSPACES,
    workspaceChats: WORKSPACE_CHATS,
    foldOf: () => undefined,
    stepsOf: () => 0,
    activeLineId: 'open-line'
  })
  const times = botSidebarChatFoldTimes(chats, {
    focusedAt: new Map([
      ['focused-today', NOW - HOUR],
      ['focused-long-ago', DAYS_AGO_4],
      ['cleared-into-session', NOW - HOUR],
      ['focus-time-nan', Number.NaN],
      ['alias-valid-today', NOW - HOUR],
      ['alias-invalid', Number.POSITIVE_INFINITY]
    ]),
    heldSessionIds: new Set(['front-session', 'revealed']),
    heldLineIds: new Set([
      'host-live-line',
      'open-line',
      'asking-grandchild',
      'asking-paged-out',
      'twin-asking-child'
    ]),
    workspaces: WORKSPACES,
    workspaceChats: WORKSPACE_CHATS,
    childrenOf: (line) => CHILDREN[identityOf(line)] ?? [],
    identityOf
  })
  const result = splitOlderBotSidebarChats(
    view.chats,
    times,
    options.now ?? NOW,
    options.keepFoldedOnly ?? null
  )
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
  chat('nan-age', { lastActiveAt: Number.NaN }),
  chat('future-age', { lastActiveAt: NOW + HOUR }),
  chat('in-front', { liveSessionId: 'front-session' }),
  chat('revealed'),
  chat('focused-today'),
  chat('focused-long-ago'),
  chat('focus-time-nan'),
  chat('focused-after-clear', { liveSessionId: 'cleared-into-session' }),
  chat('holds-host-live-line'),
  chat('holds-open-line'),
  chat('holds-asking-descendant'),
  chat('holds-paged-out-line'),
  chat('holds-remote-twin-descendant'),
  chat('holds-ambiguous-twins'),
  // A valid recent focus on its own id survives an invalid sample on its /clear successor.
  chat('alias-valid-today', { liveSessionId: 'alias-invalid' }),
  chat('turn-failed-today', { turnDone: { paneKey: 'p', at: NOW - 60_000 } }),
  chat('worker-failed-today', { finished: [worker('w-failed', 'failed', NOW - 60_000)] }),
  // Its newest worker exited without reporting: nothing dates the failure, so it never folds.
  chat('undated-failure', { finished: [worker('w-lost', 'failed')] }),
  chat('dated-failure', { finished: [worker('w-done', 'failed', DAYS_AGO_4)] }),
  // Sorted by start, an undated exit can sit behind a dated worker: it still holds the chat.
  chat('undated-behind-dated', {
    finished: [worker('w-dated', 'done', DAYS_AGO_4), worker('w-lost-later', 'failed')]
  }),
  chat('failed-2', { unseen: true })
]

const OLDER = ['failed-1', 'focused-long-ago', 'focus-time-nan', 'dated-failure', 'failed-2']

describe('splitOlderBotSidebarChats', () => {
  it('folds only settled chats a day old that nothing holds, keeping order', () => {
    expect(split(CHATS)).toEqual({
      recent: CHATS.map((each) => each.chatId).filter((id) => !OLDER.includes(id)),
      older: OLDER
    })
  })

  it('folds a chat exactly a day after it last moved, not a moment before', () => {
    const atMark = DAYS_AGO_4 + OLDER_BOT_CHAT_AGE_MS
    expect(split(CHATS, { now: atMark }).older).toEqual(OLDER)
    expect(split(CHATS, { now: atMark - 1 }).older).toEqual([])
    expect(split(CHATS, { now: Number.POSITIVE_INFINITY }).older).toEqual([])
  })

  it('folds nothing new while held to the folds already shown', () => {
    expect(
      split(CHATS, { keepFoldedOnly: new Set(['failed-1', 'failed-2', 'needs-you']) })
    ).toEqual({
      recent: CHATS.map((each) => each.chatId).filter((id) => !id.startsWith('failed-')),
      older: ['failed-1', 'failed-2']
    })
  })

  it('folds nothing when fewer than two are due', () => {
    expect(split(CHATS, { keepFoldedOnly: new Set(['failed-1']) })).toEqual({
      recent: CHATS.map((each) => each.chatId),
      older: []
    })
  })
})
