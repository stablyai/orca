import { describe, expect, it, vi } from 'vitest'
import type { BotOnHost } from '@/lib/bot-hosts'
import type { BotChatTreeChat, BotChatTreeWorker } from '../../../../shared/bots/bot-chat-tree'
import { buildBotSidebarTree } from '../../../../shared/bots/bot-sidebar-tree'
import { botSidebarWorkerLines } from './bot-sidebar-worker-lines'

type Opened = { dispatchId: string; worktreeId: string | null }
const opened = vi.hoisted((): Opened[] => [])
vi.mock('@/lib/open-orchestration-worker', () => ({
  openOrchestrationWorker: (worker: Opened) =>
    opened.push({ dispatchId: worker.dispatchId, worktreeId: worker.worktreeId }),
  revealWorkerPane: () => {
    throw new Error('a worker with a Dispatch must not open as a bare workspace')
  }
}))

const owner: BotOnHost = { hostId: 'local' }

function worker(
  key: string,
  state: BotChatTreeWorker['state'],
  extra: Partial<BotChatTreeWorker> = {}
): BotChatTreeWorker {
  return {
    key,
    title: key,
    state,
    startedAt: 1,
    worktreeId: `wt-${key}`,
    dispatchId: `d-${key}`,
    ...extra
  }
}

function lineOf(running: BotChatTreeWorker[], finished: BotChatTreeWorker[]) {
  const home: BotChatTreeChat = {
    chatId: 'home',
    title: 'Home',
    origin: 'home',
    live: 'idle',
    lastActiveAt: 1,
    unread: false,
    closed: false,
    running,
    runningTotal: running.length,
    finished,
    finishedTotal: finished.length,
    failedTotal: 0
  }
  const tree = buildBotSidebarTree({
    chats: [home],
    workspaces: [{ id: 'wt-a' }],
    workspaceChats: {},
    foldOf: () => 'open',
    stepsOf: () => 0,
    activeLineId: null
  })
  return botSidebarWorkerLines(owner, tree.workers)
}

describe('botSidebarWorkerLines', () => {
  it('draws a finished worker as done and opens the worker, not its bare workspace', () => {
    const line = lineOf([], [worker('a', 'done')])({ id: 'wt-a', hostId: 'local' })
    expect(line?.status).toBe('done')
    line?.open?.()
    expect(opened).toEqual([{ dispatchId: 'd-a', worktreeId: 'wt-a' }])
  })

  it('draws a running worker as working', () => {
    expect(lineOf([worker('b', 'running')], [])({ id: 'wt-b' })?.status).toBe('working')
  })

  it('keeps the same worktree id on two hosts as two lines', () => {
    const of = lineOf(
      [worker('remote', 'running', { worktreeId: 'wt-same', hostId: 'runtime:env2' })],
      [worker('here', 'done', { worktreeId: 'wt-same' })]
    )
    expect(of({ id: 'wt-same', hostId: 'local' })?.status).toBe('done')
    expect(of({ id: 'wt-same', hostId: 'runtime:env2' })?.status).toBe('working')
    expect(of({ id: 'wt-same', hostId: 'runtime:env3' })).toBeUndefined()
  })

  it('leaves a workspace with no recorded worker to its own status and click', () => {
    expect(lineOf([worker('b', 'running')], [])({ id: 'wt-old' })).toBeUndefined()
  })
})
