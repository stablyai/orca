// @vitest-environment happy-dom
// Bench, not a CI test: `node tests/tools/benchmarks/bot-chat-tree/bot-chat-tree-bench.mjs`.
// RPCs and renderer commits one botsChanged costs: a notice about bot 0's chats, with every bot unfolded.
import { act, cleanup, render } from '@testing-library/react'
import { Profiler } from 'react'
import { writeFileSync } from 'node:fs'
import { afterEach, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { useBots } from '@/lib/bot-catalog'
import { emitBotsChangedWindowEvent } from '@/lib/bots-changed-window-event'
import type { Bot } from '../../../../src/shared/bot-types'
import type { FolderWorkspace } from '../../../../src/shared/folder-workspaces/folder-workspace-types'
import type { BotChatTreeChat, BotChatTreeRead } from '../../../../src/shared/bots/bot-chat-tree'

const BOTS = Number(process.env.BENCH_BOTS ?? 20)
const CHATS = Number(process.env.BENCH_CHATS ?? 500)
const OUT = process.env.BENCH_OUT

const mocks = vi.hoisted(() => ({
  calls: new Map<string, number>(),
  answer: (_method: string, _params: unknown): unknown => ({})
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (_target: unknown, method: string, params?: unknown) => {
    mocks.calls.set(method, (mocks.calls.get(method) ?? 0) + 1)
    return mocks.answer(method, params)
  }
}))
vi.mock('@/components/bots/NewBotDialog', () => ({ NewBotDialog: () => null }))
vi.mock('@/components/dismiss/confirmation/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))

import { SidebarBotsSection } from '@/components/bots/SidebarBotsSection'

function makeBot(i: number): Bot {
  return {
    id: `bot-${i}`,
    name: `Bot ${i}`,
    hostId: 'local',
    folder: `bot-${i}`,
    folderWorkspaceId: `fw-${i}`,
    agent: 'claude',
    avatar: null,
    paused: false,
    permissionMode: 'ask',
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    chatSessionId: `home-${i}`,
    linear: null,
    github: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeHome(i: number): FolderWorkspace {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a bench row; only the fields the section reads.
  return {
    id: `fw-${i}`,
    projectGroupId: 'bots-group',
    name: `Bot ${i}`,
    folderPath: `/tmp/bots/bot-${i}`,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: i,
    lastActivityAt: i,
    createdAt: 0,
    updatedAt: 0
  } as FolderWorkspace
}

/** Fresh objects on every answer, as an IPC answer is. */
function chatTree(botId: string, version: number): BotChatTreeRead {
  const chats = Array.from({ length: CHATS }, (_, c): BotChatTreeChat => ({
    chatId: `${botId}-chat-${c}`,
    title: c === 1 && botId === 'bot-0' ? `Chat ${c} v${version}` : `Chat ${c}`,
    origin: c === 0 ? 'home' : 'side',
    live: 'idle',
    lastActiveAt: 1000 - c,
    unread: false,
    closed: false,
    running: [],
    runningTotal: 0,
    finished: [],
    finishedTotal: 0,
    failedTotal: 0
  }))
  return { chats, workspaceChats: {} }
}

const bots = Array.from({ length: BOTS }, (_, i) => makeBot(i))
let version = 0
mocks.answer = (method, params) => {
  const botId =
    params && typeof params === 'object' && 'botId' in params && typeof params.botId === 'string'
      ? params.botId
      : ''
  switch (method) {
    case 'bots.list':
      return { bots: bots.map((bot) => ({ ...bot })), threadReplies: false }
    case 'bots.chatTree':
      return chatTree(botId, version)
    case 'bots.groups.list':
      return { groups: [] }
    case 'bots.access.list':
      return { ok: true, value: [] }
    default:
      return { unseen: {} }
  }
}

/** Stands for every other `useBots` reader: tab rows, the closed Cmd+J, an open bot chat. */
let otherReaderRenders = 0
function OtherBotReader(): null {
  const bot = useBots().find((entry) => entry.id === 'bot-1')
  otherReaderRenders += bot ? 1 : 0
  return null
}

async function flush(ms = 1500): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it(
  `one botsChanged naming bot 0, ${BOTS} bots x ${CHATS} chats`,
  // A bench, not a CI test: 40 sidebars of 2,000-chat trees under happy-dom take minutes.
  { timeout: 600_000 },
  async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false, toFake: ['setTimeout', 'setInterval', 'Date'] })
    useAppStore.setState({ folderWorkspaces: bots.map((_, i) => makeHome(i)) })
    let commits = 0
    let commitMs = 0
    render(
      <Profiler
        id="bots"
        onRender={(_id, _phase, actual) => {
          commits += 1
          commitMs += actual
        }}
      >
        <TooltipProvider>
          <SidebarBotsSection onOpenBot={() => {}} />
          <OtherBotReader />
        </TooltipProvider>
      </Profiler>
    )
    await flush()
    await flush()

    const notices = 5
    mocks.calls.clear()
    commits = 0
    commitMs = 0
    otherReaderRenders = 0
    for (let n = 0; n < notices; n += 1) {
      version += 1
      // BENCH_MODE=before sends what an older host does: a notice that names nothing.
      act(() =>
        emitBotsChangedWindowEvent(
          'local',
          process.env.BENCH_MODE === 'before' ? undefined : { botIds: ['bot-0'], kinds: ['chats'] }
        )
      )
      await flush()
    }
    const report = {
      bots: BOTS,
      chatsPerBot: CHATS,
      perNotice: {
        rpcs: Number(([...mocks.calls.values()].reduce((a, b) => a + b, 0) / notices).toFixed(1)),
        rpcsByMethod: Object.fromEntries(
          [...mocks.calls].map(([method, count]) => [method, count / notices])
        ),
        commits: commits / notices,
        commitMs: Number((commitMs / notices).toFixed(1)),
        otherBotReaderRenders: otherReaderRenders / notices
      }
    }
    console.info(JSON.stringify(report))
    if (OUT) {
      writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
    }
  }
)
