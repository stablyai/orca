import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotOnHost } from '@/lib/bot-hosts'
import type { BotChatTreeChat, BotChatTreeWorker } from '../../../../shared/bots/bot-chat-tree'
import { botSidebarStepReadsMore, botSidebarWorkerLines } from './bot-sidebar-worker-lines'

type Opened = { dispatchId: string; worktreeId: string | null }
const opened = vi.hoisted((): Opened[] => [])
vi.mock('@/lib/open-orchestration-worker', () => ({
  openOrchestrationWorker: (worker: Opened) =>
    opened.push({ dispatchId: worker.dispatchId, worktreeId: worker.worktreeId }),
  revealWorkerPane: () => {
    throw new Error('a worker with a Dispatch must not open as a bare workspace')
  }
}))

const here: BotOnHost = { hostId: 'local' }
const paired: BotOnHost = { hostId: 'runtime:env1' }

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

function chat(running: BotChatTreeWorker[], finished: BotChatTreeWorker[]): BotChatTreeChat {
  return {
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
}

function linesOf(
  owner: BotOnHost,
  running: BotChatTreeWorker[],
  finished: BotChatTreeWorker[] = []
) {
  return botSidebarWorkerLines(owner, [chat(running, finished)])
}

beforeEach(() => {
  opened.length = 0
})

describe('botSidebarWorkerLines', () => {
  it('draws a finished worker as done and opens the worker, not its bare workspace', () => {
    const line = linesOf(here, [], [worker('a', 'done')])({ id: 'wt-a', hostId: 'local' })
    expect(line?.status).toBe('done')
    line?.open?.()
    expect(opened).toEqual([{ dispatchId: 'd-a', worktreeId: 'wt-a' }])
  })

  it.each([
    ['running', {}, 'working'],
    ['running', { waitsOnBackground: true as const }, 'monitoring'],
    ['asking-bot', {}, 'working'],
    ['needs-you', {}, 'permission'],
    ['failed', {}, 'failed'],
    ['unreachable', {}, null]
  ] as const)('draws a %s worker %o as %s', (state, extra, status) => {
    expect(linesOf(here, [worker('b', state, extra)])({ id: 'wt-b' })?.status).toBe(status)
  })

  it('shows the newest of several workers in one workspace', () => {
    const of = linesOf(
      here,
      [worker('new', 'running', { worktreeId: 'wt-x', startedAt: 9 })],
      [worker('old', 'done', { worktreeId: 'wt-x', startedAt: 2 })]
    )
    expect(of({ id: 'wt-x' })?.status).toBe('working')
  })

  it('keeps the same worktree id on two hosts as two lines', () => {
    const of = linesOf(
      here,
      [worker('remote', 'running', { worktreeId: 'wt-same', hostId: 'runtime:env2' })],
      [worker('own', 'done', { worktreeId: 'wt-same' })]
    )
    expect(of({ id: 'wt-same', hostId: 'local' })?.status).toBe('done')
    expect(of({ id: 'wt-same', hostId: 'ssh:box' })?.status).toBe('done')
    expect(of({ id: 'wt-same', hostId: 'runtime:env2' })?.status).toBe('working')
    expect(of({ id: 'wt-same', hostId: 'runtime:env3' })).toBeUndefined()
  })

  it("matches a paired owner's workers only to lines on that computer", () => {
    const of = linesOf(paired, [worker('own', 'running', { worktreeId: 'wt-same' })])
    expect(of({ id: 'wt-same', hostId: 'runtime:env1' })?.status).toBe('working')
    expect(of({ id: 'wt-same', hostId: 'local' })).toBeUndefined()
    expect(of({ id: 'wt-same', hostId: 'ssh:box' })).toBeUndefined()
    expect(of({ id: 'wt-same' })).toBeUndefined()
  })

  it('leaves a workspace with no recorded worker to its own status and click', () => {
    expect(linesOf(here, [worker('b', 'running')])({ id: 'wt-old' })).toBeUndefined()
  })
})

describe('botSidebarStepReadsMore', () => {
  it('reads the next page while the host holds finished workers it has not sent', () => {
    expect(botSidebarStepReadsMore({ finished: [worker('a', 'done')], finishedTotal: 5 }, 1)).toBe(
      true
    )
    expect(botSidebarStepReadsMore({ finished: [worker('a', 'done')], finishedTotal: 1 }, 1)).toBe(
      false
    )
    expect(botSidebarStepReadsMore({ finished: [], finishedTotal: 5 }, 0)).toBe(false)
  })
})
