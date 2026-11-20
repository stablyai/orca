import { describe, expect, it } from 'vitest'
import { botOwnChatTree, type BotChatTreeChat, type BotChatTreeWorker } from './bot-chat-tree'
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
    const chats = [
      chat('slack', { origin: 'slack', tab: true }),
      home,
      chat('untabbed', { tab: false }),
      chat('old', { closed: true })
    ]
    const workspaces = lines(18)
    const workspaceChats = { w15: 'slack', w16: 'old', w17: 'untabbed' }
    const folds = { home: 'open' } as const
    const activeLineId = 'w14'
    const tree = build(chats, workspaces, { workspaceChats, folds, activeLineId })
    const [first, slack] = tree.chats
    expect(tree.chats.map((group) => group.chat.chatId)).toEqual(['home', 'slack'])
    expect(tree.stray).toEqual([])
    expect(slack.lines.map((line) => line.id)).toEqual(['w15'])
    expect(first.lines.map((line) => line.id)).toEqual(['w1', 'w0', 'w2', 'w3', 'w14'])
    expect(first.paging).toEqual({ remaining: 11, label: 'step' })

    const [stepped] = build(chats, workspaces, {
      workspaceChats,
      folds,
      steps: { home: 1 }
    }).chats
    expect(stepped.lines).toHaveLength(12)
    expect(stepped.paging).toEqual({ remaining: 3, label: 'count' })
  })

  it('starts every chat folded, live or finished, until the owner unfolds it', () => {
    const chats = [
      chat('home', {
        origin: 'home',
        live: 'needs-you',
        lastActiveAt: 5,
        running: [runningIn('w0', 'needs-you'), runningIn('w3')],
        runningTotal: 2
      }),
      chat('done', { tab: true, finishedTotal: 1, lastActiveAt: 7 }),
      chat('kept', { tab: true, finishedTotal: 1 }),
      chat('empty', { tab: true }),
      chat('replying', { tab: true, live: 'replying', lastActiveAt: 9 })
    ]
    const tree = build(chats, lines(4), {
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
      ['home', true, false, { kind: 'summary', text: '1 waiting · 1 running' }],
      ['done', true, false, { kind: 'time', at: 7 }],
      ['kept', true, true, null],
      ['empty', false, false, null],
      ['replying', false, false, null]
    ])
  })

  it("keeps a tabless chat's live and open workspaces listed, waiting first", () => {
    const run = chat('run', {
      origin: 'automation',
      tab: false,
      running: [runningIn('w1'), runningIn('w2', 'needs-you')],
      runningTotal: 2
    })
    const tree = build([chat('home', { origin: 'home' }), run], lines(5), {
      workspaceChats: { w1: 'run', w2: 'run', w3: 'run', w4: 'run' },
      activeLineId: 'w3'
    })
    expect(tree.stray.map((line) => line.id)).toEqual(['w2', 'w1', 'w3'])
  })

  it("lists a group room's workers under Home Chat, never the room session itself", () => {
    const room = 'bot-group-member-1'
    const own = botOwnChatTree({
      chats: [
        chat('home', { origin: 'home' }),
        chat(room, { running: [runningIn('ws1', 'needs-you')], runningTotal: 1 })
      ],
      workspaceChats: { ws1: room }
    })
    const tree = build(own.chats, [{ id: 'ws1' }], {
      workspaceChats: own.workspaceChats,
      folds: { home: 'open' }
    })

    expect(tree.chats.map((view) => view.chat.chatId)).toEqual(['home'])
    expect(tree.chats[0]?.lines.map((line) => line.id)).toEqual(['ws1'])
    expect(own.chats[0]?.running.map((worker) => worker.state)).toEqual(['needs-you'])
  })

  it('keeps a room session listed when there is no Home Chat to take its workers', () => {
    const tree = { chats: [chat('bot-group-member-1')], workspaceChats: {} }
    expect(botOwnChatTree(tree)).toBe(tree)
  })
})
