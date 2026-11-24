import { describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { BotChatTreeChat, BotChatTreeWorker } from '../../../../shared/bots/bot-chat-tree'
import { buildBotSidebarTree } from '../../../../shared/bots/bot-sidebar-tree'
import { botSidebarWorkerLines } from './bot-sidebar-worker-lines'

const opened = vi.hoisted(() => [] as { dispatchId: string; worktreeId: string | null }[])
vi.mock('@/lib/open-orchestration-worker', () => ({
  openOrchestrationWorker: (worker: { dispatchId: string; worktreeId: string | null }) =>
    opened.push({ dispatchId: worker.dispatchId, worktreeId: worker.worktreeId }),
  revealWorkerPane: () => {
    throw new Error('a worker with a Dispatch must not open as a bare workspace')
  }
}))

const bot = { id: 'b1', hostId: 'local', name: 'Scout' } as Bot

function worker(key: string, state: BotChatTreeWorker['state']): BotChatTreeWorker {
  return { key, title: key, state, startedAt: 1, worktreeId: `wt-${key}`, dispatchId: `d-${key}` }
}

function linesFor(running: BotChatTreeWorker[], finished: BotChatTreeWorker[]) {
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
    workspaces: [{ id: 'wt-a' }, { id: 'wt-b' }, { id: 'wt-old' }],
    workspaceChats: {},
    foldOf: () => 'open',
    stepsOf: () => 0,
    activeLineId: null
  })
  return botSidebarWorkerLines(bot, tree.workers)
}

describe('botSidebarWorkerLines', () => {
  it('draws a finished worker as done and opens the worker, not its bare workspace', () => {
    const line = linesFor([], [worker('a', 'done')]).get('wt-a')
    expect(line?.status).toBe('done')
    line?.open?.()
    expect(opened).toEqual([{ dispatchId: 'd-a', worktreeId: 'wt-a' }])
  })

  it('draws a running worker as working', () => {
    expect(linesFor([worker('b', 'running')], []).get('wt-b')?.status).toBe('working')
  })

  it('leaves a workspace with no recorded worker to its own status and click', () => {
    expect(linesFor([worker('b', 'running')], []).has('wt-old')).toBe(false)
  })
})
