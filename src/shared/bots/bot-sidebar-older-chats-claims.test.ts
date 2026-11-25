// The fold rule fed as the desktop sidebar feeds it: the host's read built through `buildBotChatTree`,
// the sidebar's own listing (`buildBotSidebarTree`), then fold times and the split. Covers which chats a
// workspace id two hosts share holds, and what an undated settle does.
import { describe, expect, it } from 'vitest'
import type { OrchestrationSessionWorker } from '../orchestration-session-workers'
import type { BotChatTreeRead } from './bot-chat-tree'
import {
  buildBotChatTree,
  type BotChatFacts,
  type BotChatTreeDispatch,
  type BotChatTreePlaced
} from './bot-chat-tree-model'
import {
  botSidebarChatFoldTimes,
  OLDER_BOT_CHAT_AGE_MS,
  splitOlderBotSidebarChats
} from './bot-sidebar-older-chats'
import { buildBotSidebarTree } from './bot-sidebar-tree'

const HOUR = 3_600_000
const NOW = 240 * HOUR
const DAYS_AGO_5 = NOW - 120 * HOUR
const DAYS_AGO_4 = NOW - 96 * HOUR
const DAYS_AGO_3 = NOW - 72 * HOUR

type Line = { id: string; host: string }
const identityOf = (line: Line): string => `${line.host}/${line.id}`

const facts = (chatId: string, extra: Partial<BotChatFacts> = {}): BotChatFacts => ({
  chatId,
  title: chatId,
  origin: 'side',
  live: 'idle',
  lastActiveAt: DAYS_AGO_4,
  unread: false,
  closed: false,
  ...extra
})

const CHATS = [
  facts('home', { origin: 'home' }),
  facts('chat-a'),
  facts('chat-b'),
  facts('chat-c'),
  facts('chat-d')
]

type Run = {
  id: string
  chatId: string
  worktreeId: string
  at: number
  hostEnvironmentId?: string
  undated?: true
  /** Its worker record couldn't be read (the host's batch read failed): the row is a fallback. */
  unread?: true
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
function read(runs: readonly Run[], chats: readonly BotChatFacts[] = CHATS): BotChatTreeRead {
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
    chats,
    placed,
    // A failed batch read leaves the host no records for these (it reads none at all then).
    workers: new Map(runs.filter((run) => !run.unread).map((run) => [run.id, record(run)]))
  })
}

/** As the desktop sidebar does it: list the read's chats, then fold times for the listed ones. */
function sidebar(tree: BotChatTreeRead, workspaces: readonly Line[]) {
  const views = buildBotSidebarTree({
    chats: tree.chats,
    workspaces,
    workspaceChats: tree.workspaceChats,
    foldOf: () => undefined,
    stepsOf: () => 0,
    activeLineId: null
  }).chats
  const times = botSidebarChatFoldTimes(
    views.map((view) => view.chat),
    {
      focusedAt: new Map(),
      heldSessionIds: new Set(),
      heldLineIds: new Set(),
      readChats: tree.chats,
      workspaces,
      workspaceChats: tree.workspaceChats,
      childrenOf: () => [],
      identityOf
    }
  )
  const split = splitOlderBotSidebarChats(views, times, NOW, null)
  return {
    times,
    held: [...times].filter(([, at]) => !Number.isFinite(at)).map(([chatId]) => chatId),
    recent: split.recent.map((view) => view.chat.chatId),
    older: split.older.map((view) => view.chat.chatId)
  }
}

const ORDERS = [
  ['chat A ran first', DAYS_AGO_4, DAYS_AGO_3, 'chat-b'],
  ['chat B ran first', DAYS_AGO_3, DAYS_AGO_4, 'chat-a']
] as const

describe('fold: chats that claim a workspace id two physical workspaces share', () => {
  it.each(ORDERS)('holds every claimant of listed twins (%s)', (_order, aAt, bAt, mapped) => {
    // Both runs read as this host's: only the two listed workspaces show the id is shared.
    const tree = read([
      { id: 'a', chatId: 'chat-a', worktreeId: 'twin', at: aAt },
      { id: 'b', chatId: 'chat-b', worktreeId: 'twin', at: bAt },
      { id: 'c', chatId: 'chat-c', worktreeId: 'other', at: DAYS_AGO_4 }
    ])
    expect(tree.workspaceChats.twin).toBe(mapped)
    const result = sidebar(tree, [
      { id: 'twin', host: 'local' },
      { id: 'twin', host: 'remote' },
      { id: 'other', host: 'local' }
    ])
    expect(result.held).toEqual(['home', 'chat-a', 'chat-b'])
    expect(result.older).toEqual(['chat-c', 'chat-d'])
  })

  it.each(ORDERS)('holds them when only the workers name two hosts (%s)', (_order, aAt, bAt) => {
    // One workspace listed (the other host is out of reach), yet the two runs name two hosts.
    const tree = read([
      { id: 'a', chatId: 'chat-a', worktreeId: 'twin', at: aAt },
      { id: 'b', chatId: 'chat-b', worktreeId: 'twin', at: bAt, hostEnvironmentId: 'env-remote' }
    ])
    const result = sidebar(tree, [{ id: 'twin', host: 'local' }])
    expect(result.held).toEqual(['home', 'chat-a', 'chat-b'])
  })

  it.each(ORDERS)(
    'lets an earlier chat fold when one workspace was reused (%s)',
    (_o, aAt, bAt) => {
      // One physical workspace, used by chat A then chat B (or the reverse): nothing is ambiguous.
      const tree = read([
        { id: 'a', chatId: 'chat-a', worktreeId: 'reused', at: aAt },
        { id: 'b', chatId: 'chat-b', worktreeId: 'reused', at: bAt }
      ])
      const result = sidebar(tree, [{ id: 'reused', host: 'local' }])
      expect(result.held).toEqual(['home'])
      expect(result.times.get('chat-a')).toBe(Math.max(aAt, DAYS_AGO_4) + OLDER_BOT_CHAT_AGE_MS)
      expect(result.times.get('chat-b')).toBe(Math.max(bAt, DAYS_AGO_4) + OLDER_BOT_CHAT_AGE_MS)
    }
  )

  // Chat B has no tab, so it lists no row; its shown worker is still evidence of a second host.
  const withHiddenB = (bRuns: Run[]): BotChatTreeRead =>
    read(
      [{ id: 'a', chatId: 'chat-a', worktreeId: 'w', at: DAYS_AGO_3 }, ...bRuns],
      CHATS.map((chat) => (chat.chatId === 'chat-b' ? { ...chat, tab: false } : chat))
    )

  it('takes host evidence from a chat the sidebar does not list', () => {
    const tree = withHiddenB([
      { id: 'b', chatId: 'chat-b', worktreeId: 'w', at: DAYS_AGO_4, hostEnvironmentId: 'env-r' }
    ])
    const result = sidebar(tree, [{ id: 'w', host: 'local' }])
    expect(result.recent).toEqual(['home', 'chat-a'])
    expect(result.older).toEqual(['chat-c', 'chat-d'])
    expect(result.times.has('chat-b')).toBe(false)
  })

  it('lets the chat fold when the hidden chat ran on the same host', () => {
    const tree = withHiddenB([{ id: 'b', chatId: 'chat-b', worktreeId: 'w', at: DAYS_AGO_4 }])
    const result = sidebar(tree, [{ id: 'w', host: 'local' }])
    expect(result.older).toEqual(['chat-a', 'chat-c', 'chat-d'])
  })

  it('takes no evidence from a worker past the shown finished page', () => {
    // B's remote run is its oldest of three: past the two finished rows the read shows.
    const tree = withHiddenB([
      { id: 'b1', chatId: 'chat-b', worktreeId: 'w', at: DAYS_AGO_5, hostEnvironmentId: 'env-r' },
      { id: 'b2', chatId: 'chat-b', worktreeId: 'x', at: DAYS_AGO_4 },
      { id: 'b3', chatId: 'chat-b', worktreeId: 'y', at: DAYS_AGO_4 }
    ])
    expect(tree.chats.find((chat) => chat.chatId === 'chat-b')!.finished).toHaveLength(2)
    const result = sidebar(tree, [{ id: 'w', host: 'local' }])
    expect(result.older).toEqual(['chat-a', 'chat-c', 'chat-d'])
  })

  it('holds a claimant whose worker record could not be read', () => {
    // A's record is missing (the batch read failed): its row is a fallback, still placed on the twin.
    const tree = read([
      { id: 'a', chatId: 'chat-a', worktreeId: 'twin', at: DAYS_AGO_4, unread: true },
      { id: 'b', chatId: 'chat-b', worktreeId: 'twin', at: DAYS_AGO_3 },
      { id: 'c', chatId: 'chat-c', worktreeId: 'other', at: DAYS_AGO_4 }
    ])
    expect(tree.workspaceChats.twin).toBe('chat-b')
    const fallback = tree.chats.find((chat) => chat.chatId === 'chat-a')!.finished[0]!
    expect(fallback.worktreeId).toBeUndefined()
    const result = sidebar(tree, [
      { id: 'twin', host: 'local' },
      { id: 'twin', host: 'remote' },
      { id: 'other', host: 'local' }
    ])
    expect(result.held).toEqual(['home', 'chat-a', 'chat-b'])
    expect(result.times.get('chat-c')).toBe(DAYS_AGO_4 + OLDER_BOT_CHAT_AGE_MS)
  })

  it('never reads an unread record as a second host', () => {
    // One workspace: B's record places it remote, A's fallback names no host. Not a collision.
    const tree = read([
      { id: 'a', chatId: 'chat-a', worktreeId: 'w', at: DAYS_AGO_4, unread: true },
      { id: 'b', chatId: 'chat-b', worktreeId: 'w', at: DAYS_AGO_3, hostEnvironmentId: 'env-r' }
    ])
    const result = sidebar(tree, [{ id: 'w', host: 'remote' }])
    expect(result.held).toEqual(['home'])
    expect(result.older).toEqual(['chat-a', 'chat-b', 'chat-c', 'chat-d'])
  })
})

describe('fold: a settled Dispatch with no completion time', () => {
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
    const result = sidebar(tree, [])
    expect(result.times.get('chat-a')).toBe(Number.POSITIVE_INFINITY)
    expect(result.times.get('chat-b')).toBe(DAYS_AGO_4 + OLDER_BOT_CHAT_AGE_MS)
  })
})
