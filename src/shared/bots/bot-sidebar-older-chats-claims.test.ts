// The fold rule fed by the host's own read model: which chats a workspace's claims hold, and what an
// undated settle does, built through `buildBotChatTree` as the host builds it.
import { describe, expect, it } from 'vitest'
import type { OrchestrationSessionWorker } from '../orchestration-session-workers'
import type { BotChatTreeRead } from './bot-chat-tree'
import {
  buildBotChatTree,
  type BotChatFacts,
  type BotChatTreeDispatch,
  type BotChatTreePlaced
} from './bot-chat-tree-model'
import { botSidebarChatFoldTimes, OLDER_BOT_CHAT_AGE_MS } from './bot-sidebar-older-chats'

const HOUR = 3_600_000
const NOW = 240 * HOUR
const DAYS_AGO_4 = NOW - 96 * HOUR
const DAYS_AGO_3 = NOW - 72 * HOUR

type Line = { id: string; host: string }
const identityOf = (line: Line): string => `${line.host}/${line.id}`

const facts = (chatId: string, origin: BotChatFacts['origin'] = 'side'): BotChatFacts => ({
  chatId,
  title: chatId,
  origin,
  live: 'idle',
  lastActiveAt: DAYS_AGO_4,
  unread: false,
  closed: false
})

const CHATS = [facts('home', 'home'), facts('chat-a'), facts('chat-b'), facts('chat-c')]

type Run = {
  id: string
  chatId: string
  worktreeId: string
  at: number
  hostEnvironmentId?: string
  undated?: true
}

function record(run: Run): OrchestrationSessionWorker {
  return {
    dispatchId: run.id,
    taskId: `task-${run.id}`,
    runId: 'run',
    title: run.id,
    agent: 'claude',
    state: run.undated ? 'failed' : 'completed',
    liveness: 'exited',
    host: run.hostEnvironmentId ? 'remote' : 'local',
    ...(run.hostEnvironmentId ? { hostEnvironmentId: run.hostEnvironmentId } : {}),
    worktreeId: run.worktreeId,
    paneKey: null,
    chatSessionId: null,
    startedAt: run.at - HOUR,
    settledAt: run.at
  }
}

/** The host's read for these settled runs: each workspace sits under its newest Dispatch's chat. */
function read(runs: readonly Run[]): BotChatTreeRead {
  const placed: BotChatTreePlaced[] = runs.map((run) => {
    const dispatch: BotChatTreeDispatch = {
      id: run.id,
      chatId: run.chatId,
      settled: true,
      failed: run.undated === true,
      at: run.at,
      worktreeId: run.worktreeId,
      ...(run.undated ? { undated: true as const } : {})
    }
    return { dispatch, chatId: run.chatId }
  })
  return buildBotChatTree({
    chats: CHATS,
    placed,
    workers: new Map(runs.map((run) => [run.id, record(run)]))
  })
}

function foldTimes(tree: BotChatTreeRead, workspaces: readonly Line[]): Map<string, number> {
  return botSidebarChatFoldTimes(tree.chats, {
    focusedAt: new Map(),
    heldSessionIds: new Set(),
    heldLineIds: new Set(),
    workspaces,
    workspaceChats: tree.workspaceChats,
    childrenOf: () => [],
    identityOf
  })
}

const held = (times: ReadonlyMap<string, number>): string[] =>
  [...times].filter(([, at]) => !Number.isFinite(at)).map(([chatId]) => chatId)

const LISTED_TWINS: Line[] = [
  { id: 'twin', host: 'local' },
  { id: 'twin', host: 'remote' },
  { id: 'other', host: 'local' }
]

describe('botSidebarChatFoldTimes: chats that claim a workspace id two physical workspaces share', () => {
  // Chat A ran on the local twin, chat B on the remote one; the read maps the id to whichever ran last.
  const twinRuns = (aAt: number, bAt: number): Run[] => [
    { id: 'a', chatId: 'chat-a', worktreeId: 'twin', at: aAt },
    { id: 'b', chatId: 'chat-b', worktreeId: 'twin', at: bAt, hostEnvironmentId: 'env-remote' },
    { id: 'c', chatId: 'chat-c', worktreeId: 'other', at: DAYS_AGO_4 }
  ]

  it.each([
    ['chat A older', DAYS_AGO_4, DAYS_AGO_3, 'chat-b'],
    ['chat B older', DAYS_AGO_3, DAYS_AGO_4, 'chat-a']
  ])('holds every claimant whichever ran last (%s)', (_order, aAt, bAt, mapped) => {
    const tree = read(twinRuns(aAt, bAt))
    expect(tree.workspaceChats.twin).toBe(mapped)
    expect(held(foldTimes(tree, LISTED_TWINS))).toEqual(['home', 'chat-a', 'chat-b'])
  })

  it.each([
    ['chat A older', DAYS_AGO_4, DAYS_AGO_3],
    ['chat B older', DAYS_AGO_3, DAYS_AGO_4]
  ])('holds them when only the workers name the two hosts (%s)', (_order, aAt, bAt) => {
    // The remote twin isn't listed (its host is out of reach), yet the two runs name two hosts.
    const tree = read(twinRuns(aAt, bAt))
    const times = foldTimes(tree, [
      { id: 'twin', host: 'local' },
      { id: 'other', host: 'local' }
    ])
    expect(held(times)).toEqual(['home', 'chat-a', 'chat-b'])
  })

  it.each([
    ['chat A older', DAYS_AGO_4, DAYS_AGO_3],
    ['chat B older', DAYS_AGO_3, DAYS_AGO_4]
  ])('lets an earlier chat fold when one workspace was only reused (%s)', (_order, aAt, bAt) => {
    // One physical workspace, used by chat A then chat B (or the reverse): nothing is ambiguous.
    const tree = read([
      { id: 'a', chatId: 'chat-a', worktreeId: 'reused', at: aAt },
      { id: 'b', chatId: 'chat-b', worktreeId: 'reused', at: bAt },
      { id: 'c', chatId: 'chat-c', worktreeId: 'other', at: DAYS_AGO_4 }
    ])
    const times = foldTimes(tree, [
      { id: 'reused', host: 'local' },
      { id: 'other', host: 'local' }
    ])
    expect(held(times)).toEqual(['home'])
    expect(times.get('chat-a')).toBe(Math.max(aAt, DAYS_AGO_4) + OLDER_BOT_CHAT_AGE_MS)
    expect(times.get('chat-b')).toBe(Math.max(bAt, DAYS_AGO_4) + OLDER_BOT_CHAT_AGE_MS)
  })
})

describe('botSidebarChatFoldTimes: a settled Dispatch with no completion time', () => {
  it('lists it in order but never dates the chat from its creation time', () => {
    const tree = read([
      { id: 'a', chatId: 'chat-a', worktreeId: 'w-a', at: DAYS_AGO_4, undated: true },
      { id: 'b', chatId: 'chat-b', worktreeId: 'w-b', at: DAYS_AGO_4 }
    ])
    const undated = tree.chats.find((chat) => chat.chatId === 'chat-a')!.finished[0]!
    // Still ordered (and paged) by the time it was read with; flagged as no settle evidence.
    expect(undated.settledAt).toBe(DAYS_AGO_4)
    expect(undated.settledUndated).toBe(true)
    // The row still reads as failed, not as going.
    expect(undated.state).toBe('failed')
    const times = foldTimes(tree, [])
    expect(times.get('chat-a')).toBe(Number.POSITIVE_INFINITY)
    expect(times.get('chat-b')).toBe(DAYS_AGO_4 + OLDER_BOT_CHAT_AGE_MS)
  })
})
