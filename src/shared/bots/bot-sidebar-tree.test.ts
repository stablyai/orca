import { describe, expect, it } from 'vitest'
import type { BotChatTreeChat, BotChatTreeWorker } from './bot-chat-tree'
import { buildBotSidebarTree } from './bot-sidebar-tree'

const chat = (chatId: string, extra: Partial<BotChatTreeChat> = {}): BotChatTreeChat => ({
  chatId,
  title: chatId,
  origin: 'side',
  live: 'idle',
  lastActiveAt: 0,
  unread: false,
  closed: false,
  running: [],
  runningTotal: 0,
  finished: [],
  finishedTotal: 0,
  failedTotal: 0,
  ...extra
})

const runningIn = (worktreeId: string, state: BotChatTreeWorker['state'] = 'running') => ({
  key: worktreeId,
  title: worktreeId,
  state,
  startedAt: 0,
  worktreeId
})

const lines = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `w${i}` }))

function build(
  chats: BotChatTreeChat[],
  workspaces: { id: string }[],
  options: {
    workspaceChats?: Record<string, string>
    folds?: Record<string, 'open' | 'folded'>
    steps?: Record<string, number>
    activeLineId?: string
  } = {}
) {
  return buildBotSidebarTree({
    chats,
    workspaces,
    workspaceChats: options.workspaceChats ?? {},
    foldOf: (chatId) => options.folds?.[chatId],
    stepsOf: (chatId) => options.steps?.[chatId] ?? 0,
    activeLineId: options.activeLineId ?? null
  })
}

describe('buildBotSidebarTree', () => {
  it('pages a chat after its live workspaces and the last 2 finished, a full step then the rest', () => {
    const home = chat('home', {
      origin: 'home',
      running: [runningIn('w0'), runningIn('w1', 'needs-you')],
      runningTotal: 2
    })
    const [first] = build([home], lines(15), { folds: { home: 'open' } }).chats
    expect(first.lines.map((line) => line.id)).toEqual(['w1', 'w0', 'w2', 'w3'])
    expect(first.paging).toEqual({ remaining: 11, label: 'step' })

    const [stepped] = build([home], lines(15), {
      folds: { home: 'open' },
      steps: { home: 1 }
    }).chats
    expect(stepped.lines).toHaveLength(12)
    expect(stepped.paging).toEqual({ remaining: 3, label: 'count' })
  })

  it('keeps the open workspace listed past the page', () => {
    const [home] = build([chat('home', { origin: 'home' })], lines(6), {
      folds: { home: 'open' },
      activeLineId: 'w5'
    }).chats
    expect(home.lines.map((line) => line.id)).toEqual(['w0', 'w1', 'w5'])
  })

  it('starts every chat folded, live or finished, until the owner unfolds it', () => {
    const chats = [
      chat('home', {
        origin: 'home',
        live: 'needs-you',
        running: [runningIn('w0', 'needs-you')],
        runningTotal: 1
      }),
      chat('done', { tab: true, finishedTotal: 1, lastActiveAt: 7 }),
      chat('kept', { tab: true, finishedTotal: 1 }),
      chat('empty', { tab: true })
    ]
    const tree = build(chats, lines(3), {
      workspaceChats: { w1: 'done', w2: 'kept' },
      folds: { kept: 'open' }
    })
    expect(
      tree.chats.map(({ chat, foldable, open, trailing }) => [
        chat.chatId,
        foldable,
        open,
        trailing
      ])
    ).toEqual([
      ['home', true, false, { kind: 'summary', text: '1 waiting' }],
      ['done', true, false, { kind: 'time', at: 7 }],
      ['kept', true, true, null],
      ['empty', false, false, null]
    ])
  })

  it("shows a folded chat's live counts, else its time; nothing while it replies", () => {
    const tree = build(
      [
        chat('home', {
          origin: 'home',
          lastActiveAt: 5,
          running: [runningIn('w0', 'needs-you'), runningIn('w1')],
          runningTotal: 2
        }),
        chat('quiet', { tab: true, lastActiveAt: 7 }),
        chat('replying', { tab: true, live: 'replying', lastActiveAt: 9 })
      ],
      lines(3),
      { workspaceChats: { w2: 'quiet' }, folds: { home: 'folded' } }
    )
    expect(tree.chats.map(({ trailing }) => trailing)).toEqual([
      { kind: 'summary', text: '1 waiting · 1 running' },
      { kind: 'time', at: 7 },
      null
    ])
  })

  it('lists the open workspace after the chats when its chat has no tab', () => {
    const tree = build([chat('home', { origin: 'home' }), chat('side', { tab: false })], lines(2), {
      workspaceChats: { w1: 'side' },
      activeLineId: 'w1'
    })
    expect(tree.stray).toEqual([{ id: 'w1' }])
  })

  it("keeps a tabless chat's live workspaces listed once another row is open, waiting first", () => {
    const run = chat('run', {
      origin: 'automation',
      tab: false,
      running: [runningIn('w1'), runningIn('w2', 'needs-you')],
      runningTotal: 2
    })
    const tree = build([chat('home', { origin: 'home' }), run], lines(4), {
      workspaceChats: { w1: 'run', w2: 'run', w3: 'run' }
    })
    expect(tree.stray.map((line) => line.id)).toEqual(['w2', 'w1'])
  })
})
