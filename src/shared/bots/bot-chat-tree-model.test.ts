import { describe, expect, it } from 'vitest'
import type { OrchestrationSessionWorker } from '../orchestration-session-workers'
import {
  botChatTreeDispatchIds,
  botChatTreeDispatchWorker,
  buildBotChatTree,
  mergeShownFinished,
  placeBotChatDispatches,
  type BotChatFacts,
  type BotChatTreeDispatch
} from './bot-chat-tree-model'

function facts(chatId: string, patch: Partial<BotChatFacts> = {}): BotChatFacts {
  return {
    chatId,
    title: chatId,
    origin: 'side',
    live: 'idle',
    lastActiveAt: 0,
    unread: false,
    closed: false,
    ...patch
  }
}

function dispatch(id: string, patch: Partial<BotChatTreeDispatch> = {}): BotChatTreeDispatch {
  return { id, chatId: null, settled: true, failed: false, at: 0, worktreeId: null, ...patch }
}

function worker(dispatchId: string, patch: Partial<OrchestrationSessionWorker> = {}) {
  return {
    dispatchId,
    taskId: `task-${dispatchId}`,
    runId: 'run',
    title: `Worker ${dispatchId}`,
    agent: 'claude',
    state: 'completed',
    liveness: 'exited',
    host: 'local',
    worktreeId: null,
    paneKey: null,
    chatSessionId: null,
    startedAt: 1,
    settledAt: 2,
    ...patch
  } satisfies OrchestrationSessionWorker
}

const chats = [
  facts('home', { origin: 'home' }),
  facts('slack', { origin: 'slack' }),
  facts('old', { closed: true })
]

describe('placeBotChatDispatches', () => {
  it('puts workers with no chat under Home, and a closed chat running worker there until it settles', () => {
    const placed = placeBotChatDispatches(chats, [
      dispatch('a', { chatId: 'slack' }),
      dispatch('b', { chatId: null }),
      dispatch('c', { chatId: 'gone' }),
      dispatch('d', { chatId: 'old', settled: false }),
      dispatch('e', { chatId: 'old' })
    ])
    expect(placed.map(({ dispatch: d, chatId, note }) => [d.id, chatId, note])).toEqual([
      ['a', 'slack', undefined],
      ['b', 'home', undefined],
      ['c', 'home', undefined],
      ['d', 'home', 'from-closed-chat'],
      ['e', 'old', undefined]
    ])
  })
})

describe('buildBotChatTree', () => {
  const dispatches = [
    dispatch('r1', { chatId: 'slack', settled: false, at: 50, worktreeId: 'wt-1' }),
    dispatch('f1', { chatId: 'slack', at: 10, worktreeId: 'wt-1' }),
    dispatch('f2', { chatId: 'slack', at: 30, failed: true, worktreeId: 'wt-2' }),
    dispatch('f3', { chatId: 'slack', at: 20 }),
    dispatch('f4', { chatId: 'slack', at: 40 })
  ]

  it('reads only the running workers and each chat last 2 finished', () => {
    const placed = placeBotChatDispatches(chats, dispatches)
    expect(botChatTreeDispatchIds(chats, placed, []).sort()).toEqual(['f2', 'f4', 'r1'])
    expect(
      botChatTreeDispatchIds(chats, placed, [], {
        chatId: 'slack',
        after: { at: 30, key: 'worker:f2' }
      }).sort()
    ).toEqual(['f1', 'f3', 'r1'])
  })

  it('lists running first-needs-you, the newest finished, totals and the failed count', () => {
    const placed = placeBotChatDispatches(chats, dispatches)
    const tree = buildBotChatTree({
      chats,
      placed,
      workers: new Map([
        [
          'r1',
          worker('r1', { state: 'working', activity: 'blocked', settledAt: null, liveness: 'live' })
        ],
        ['f2', worker('f2', { state: 'failed' })],
        ['f4', worker('f4')]
      ]),
      homeWorkspaceIds: ['wt-handed']
    })
    const slack = tree.chats.find((chat) => chat.chatId === 'slack')!
    expect(slack.running.map((w) => [w.key, w.state])).toEqual([['worker:r1', 'needs-you']])
    expect(slack.finished.map((w) => [w.key, w.state])).toEqual([
      ['worker:f4', 'done'],
      ['worker:f2', 'failed']
    ])
    expect([slack.runningTotal, slack.finishedTotal, slack.failedTotal]).toEqual([1, 4, 1])
    expect(tree.workspaceChats).toEqual({ 'wt-1': 'slack', 'wt-2': 'slack', 'wt-handed': 'home' })
  })

  it('pages one chat from just past the last worker shown, even after another finished', () => {
    // f5 finished after f4 and f2 were shown; the next page still starts right after f2.
    const placed = placeBotChatDispatches(chats, [
      ...dispatches,
      dispatch('f5', { chatId: 'slack', at: 60 })
    ])
    const tree = buildBotChatTree({
      chats,
      placed,
      workers: new Map([
        ['f3', worker('f3')],
        ['f1', worker('f1')]
      ]),
      page: { chatId: 'slack', after: { at: 30, key: 'worker:f2' } }
    })
    expect(tree.chats.map((chat) => chat.chatId)).toEqual(['slack'])
    expect(tree.chats[0].finished.map((w) => w.key)).toEqual(['worker:f3', 'worker:f1'])
  })

  it('gives a bot with no Home Chat yet an empty Home row for its handed-over work', () => {
    const tree = buildBotChatTree({
      chats: [],
      placed: [],
      workers: new Map(),
      extras: [
        {
          worker: {
            key: 'agent:x',
            title: 'Moved in',
            state: 'running',
            startedAt: 5,
            note: 'handed-over'
          },
          settled: false,
          at: 5
        }
      ]
    })
    expect(tree.chats.map((chat) => [chat.chatId, chat.origin, chat.runningTotal])).toEqual([
      ['', 'home', 1]
    ])
  })
})

describe('mergeShownFinished', () => {
  const done = (key: string, at: number) => ({
    key,
    title: key,
    state: 'done' as const,
    startedAt: 0,
    settledAt: at
  })

  it('keeps every row shown when a worker finishes between pages', () => {
    // Shown: f1, f2, then a page f3, f4. f0 finishes; the host's newest 2 are now f0, f1.
    const loaded = [done('f1', 90), done('f2', 80), done('f3', 70), done('f4', 60)]
    const merged = mergeShownFinished([done('f0', 100), done('f1', 90)], loaded)
    expect(merged.map((worker) => worker.key)).toEqual(['f0', 'f1', 'f2', 'f3', 'f4'])
  })
})

describe('botChatTreeDispatchWorker', () => {
  const open = (patch: Partial<OrchestrationSessionWorker>) =>
    botChatTreeDispatchWorker(
      { dispatch: dispatch('w', { settled: false }), chatId: 'home' },
      worker('w', { settledAt: null, activity: 'unknown', ...patch })
    )

  it("shows a paired server's worker resting on its ask as asking, on that server", () => {
    expect(
      open({
        state: 'working',
        liveness: 'live',
        host: 'remote',
        hostEnvironmentId: 'env-win',
        pendingQuestion: true
      })
    ).toMatchObject({ state: 'asking-bot', hostId: 'runtime:env-win' })
  })

  it('never shows an out-of-contact worker as running', () => {
    expect(
      open({ state: 'unverifiable', liveness: 'unverifiable', pendingQuestion: true })
    ).toMatchObject({ state: 'asking-bot' })
    expect(
      open({ state: 'unverifiable', liveness: 'unverifiable', pendingQuestion: false })
    ).toMatchObject({ state: 'unreachable' })
    expect(open({ state: 'working', liveness: 'live', pendingQuestion: false })).toMatchObject({
      state: 'running'
    })
  })
})
