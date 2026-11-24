// A live bot card to click around in: a bot on a paired server, with chats, the workers they started,
// and asks waiting on the owner. Open it in `pnpm dev:fixtures` at /fixtures?id=bots/BotCardPlayground:playground.
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots, stubServerBots } from '../../component-fixtures/fixture-bots'
import { publishBots, setBotHostListing } from '@/lib/bot-catalog-snapshot'
import { useBots } from '@/lib/bot-catalog'
import { useAppStore } from '@/store'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { structuredAgentSessionStatusPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-tab'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { mascotAvatar } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import type { BotActivity, BotWorkerRow } from '../../../../shared/bots/bot-activity-model'
import type { BotChatTreeChat, BotChatTreeRead } from '../../../../shared/bots/bot-chat-tree'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../shared/repository/repo-types'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace/identity/workspace-scope'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { BotSidebarEntry } from './BotSidebarEntry'

const now = Date.now()
const MIN = 60_000
const M4: ExecutionHostId = 'runtime:m4'

const releaseBot: Bot = {
  id: 'release',
  name: 'Bot-Release-Manager',
  // A host stores its own bots as `local`; the listing stamps the server that read them.
  hostId: 'local',
  folder: 'bot-release-manager',
  folderWorkspaceId: 'fw-release',
  agent: 'claude',
  avatar: mascotAvatar('M1'),
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'chat-release',
  createdAt: 1,
  updatedAt: 1
}

const localBot: Bot = {
  ...releaseBot,
  id: 'docs',
  name: 'Docs bot',
  folder: 'docs-bot',
  folderWorkspaceId: 'fw-docs',
  avatar: mascotAvatar('H1'),
  chatSessionId: 'chat-docs'
}

const SOULS = {
  [releaseBot.id]:
    '# Bot-Release-Manager\n\nHelp Orca ship daily releases by identifying blockers, coordinating release cuts, scanning for regressions.\n'
}

// The bot's home lists locally here, so its workers nest under it the simple way; the bot itself is m4's.
const home = makeFolderWorkspace({
  id: releaseBot.folderWorkspaceId,
  name: releaseBot.name,
  folderPath: `~/.orca/bots/${releaseBot.folder}`
})
const docsHome = makeFolderWorkspace({
  id: localBot.folderWorkspaceId,
  name: localBot.name,
  folderPath: `~/.orca/bots/${localBot.folder}`
})

const repo: Repo = {
  id: 'orca',
  path: '/src/orca',
  displayName: 'orca',
  badgeColor: '',
  addedAt: 1,
  executionHostId: 'local'
}

type Line = {
  name: string
  title: string
  chat: string
  state: AgentStatusEntry['state']
}

const LINES: Line[] = [
  { name: 'cut-rc', title: 'Cut RC 1.4.232', chat: 'chat-release', state: 'working' },
  { name: 'notes', title: 'Draft release notes', chat: 'chat-release', state: 'waiting' },
  { name: 'flaky', title: 'Fix flaky sidebar test', chat: 'side-blockers', state: 'blocked' },
  { name: 'scan', title: 'Scan for regressions', chat: 'side-blockers', state: 'working' },
  { name: 'bisect', title: 'Bisect perf drop', chat: 'side-blockers', state: 'done' },
  { name: 'bump', title: 'Bump version', chat: 'chat-release', state: 'done' }
]

const worktrees = LINES.map((line) =>
  makeWorktree({
    id: `orca::/src/orca/${line.name}`,
    repoId: repo.id,
    path: `/src/orca/${line.name}`,
    branch: line.name,
    displayName: line.title
  })
)
const worktreeOf = (line: Line) => worktrees[LINES.indexOf(line)]!

const workerAgents: AgentStatusEntry[] = LINES.map((line) => ({
  paneKey: `pane-${line.name}`,
  worktreeId: worktreeOf(line).id,
  agentType: 'claude',
  state: line.state,
  prompt: line.title,
  updatedAt: now - 2 * MIN,
  stateStartedAt: now - 2 * MIN,
  stateHistory: []
}))

const homeChat: AgentStatusEntry = {
  paneKey: structuredAgentSessionStatusPaneKey(releaseBot.chatSessionId!),
  worktreeId: folderWorkspaceKey(home.id),
  agentType: 'claude',
  state: 'working',
  prompt: '',
  updatedAt: now - 4 * MIN,
  stateStartedAt: now - 4 * MIN,
  stateHistory: [],
  toolName: 'Bash',
  toolInput:
    'cd ~/.orca/bots/bot-release-manager; "${ORCA_CLI_COMMAND:-orca}" orchestration dispatch --task "Cut RC 1.4.232" --worktree new --agent claude'
}

function treeChat(
  chatId: string,
  title: string,
  origin: BotChatTreeChat['origin'],
  live: BotChatTreeChat['live']
): BotChatTreeChat {
  const mine = LINES.filter((line) => line.chat === chatId)
  const asTreeWorker = (line: Line) => ({
    key: `worker:${line.name}`,
    title: line.title,
    branch: line.name,
    state:
      line.state === 'done'
        ? ('done' as const)
        : line.state === 'working'
          ? ('running' as const)
          : ('needs-you' as const),
    startedAt: now - 10 * MIN,
    worktreeId: worktreeOf(line).id,
    dispatchId: `dispatch-${line.name}`
  })
  const running = mine.filter((line) => line.state !== 'done').map(asTreeWorker)
  const finished = mine.filter((line) => line.state === 'done').map(asTreeWorker)
  return {
    chatId,
    title,
    origin,
    live,
    lastActiveAt: now - 3 * MIN,
    unread: false,
    closed: false,
    tab: true,
    running,
    runningTotal: running.length,
    finished,
    finishedTotal: finished.length,
    failedTotal: 0
  }
}

const CHAT_TREE: BotChatTreeRead = {
  chats: [
    treeChat('chat-release', 'Home Chat', 'home', 'idle'),
    treeChat('side-blockers', 'Find release blockers', 'side', 'needs-you')
  ],
  workspaceChats: Object.fromEntries(LINES.map((line) => [worktreeOf(line).id, line.chat]))
}

function workerRow(line: Line, permission: boolean): BotWorkerRow {
  return {
    kind: 'worker',
    key: `worker:${line.name}`,
    dispatchId: `dispatch-${line.name}`,
    title: line.title,
    dot: permission ? 'permission' : 'waiting',
    origin: { kind: 'chat' },
    paneKey: `pane-${line.name}`,
    workspaceId: worktreeOf(line).id,
    at: now - 2 * MIN,
    worker: null,
    ...(permission ? { tool: { name: 'Bash', input: 'git push origin release/1.4.232' } } : {})
  }
}

const ACTIVITY: BotActivity = {
  workers: [
    workerRow(
      LINES.find((line) => line.name === 'flaky')!,
      true
    ),
    workerRow(
      LINES.find((line) => line.name === 'notes')!,
      false
    )
  ],
  inProgress: [],
  completed: [],
  automations: [],
  waits: []
}

/** Its items flagged for the owner, beyond the asks Activity lists. */
const ITEMS_NEEDING_YOU = 2

/** m4's answers to the reads a bot row and its hover card make; everything else as stubServerBots answers. */
function stubM4Reads(): void {
  const environments = window.api.runtimeEnvironments
  const fallback = environments.call
  Reflect.set(window.api, 'runtimeEnvironments', {
    ...environments,
    call: async (request: Parameters<typeof fallback>[0]) => {
      const results: Record<string, unknown> = {
        'bots.chatTree': CHAT_TREE,
        'bots.activity': { activity: ACTIVITY },
        'bots.chats.own': {
          chats: [{ sessionId: 'side-blockers', title: 'Find release blockers' }]
        }
      }
      return request.selector === 'm4' && request.method in results
        ? { ok: true, result: results[request.method] }
        : fallback(request)
    }
  })
}

function Sidebar(): React.JSX.Element {
  const bots = useBots()
  const onM4 = bots.find((entry) => entry.id === releaseBot.id && entry.hostId === M4)
  const here = bots.find((entry) => entry.id === localBot.id && entry.hostId === 'local')
  return (
    <div className="flex w-[300px] flex-col gap-0.5 rounded-lg border border-border bg-worktree-sidebar py-1 pr-1.5 pl-1 text-worktree-sidebar-foreground">
      {onM4 ? <BotSidebarEntry bot={onM4} home={home} isActive={false} onOpen={() => {}} /> : null}
      {here ? (
        <BotSidebarEntry bot={here} home={docsHome} isActive={false} onOpen={() => {}} />
      ) : null}
    </div>
  )
}

const base = defineFixture({
  width: 340,
  store: {
    runtimeEnvironments: [
      {
        id: 'm4',
        name: 'm4air',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [],
        preferredEndpointId: 'm4'
      }
    ],
    runtimeStatusByEnvironmentId: new Map([
      ['m4', { status: createCompatibleRuntimeStatusResponse('m4').result, checkedAt: 1 }]
    ]),
    repos: [repo],
    folderWorkspaces: [home, docsHome],
    worktreesByRepo: { [repo.id]: worktrees },
    worktreeLineageById: {},
    workspaceLineageByChildKey: Object.fromEntries(
      worktrees.map((entry) => [
        worktreeWorkspaceKey(entry.id),
        {
          childWorkspaceKey: worktreeWorkspaceKey(entry.id),
          parentWorkspaceKey: folderWorkspaceKey(home.id),
          origin: 'orchestration' as const,
          capture: { source: 'orchestration-context' as const, confidence: 'explicit' as const },
          createdAt: 1
        }
      ])
    ),
    agentStatusByPaneKey: acceptedAgentStatuses(
      [homeChat, ...workerAgents].map((entry) => [entry.paneKey, entry])
    )
  },
  setup: () => {
    setBotHostListing({
      hosts: [
        { hostId: 'local', state: 'live' },
        { hostId: M4, state: 'live' }
      ],
      updateNeeded: []
    })
    stubBots([localBot])
    publishBots(
      [releaseBot],
      {
        threadReplies: false,
        webhooks: undefined,
        needsYou: { [releaseBot.id]: ITEMS_NEEDING_YOU },
        needsYouAt: now
      },
      M4
    )
    stubServerBots({ m4: [releaseBot] }, SOULS)
    stubM4Reads()
    // Folds are real here: the store's own toggles, without saving to a profile.
    useAppStore.setState({
      collapsedGroups: new Set(),
      toggleCollapsedGroup: (key: string) =>
        useAppStore.setState((state) => {
          const next = new Set(state.collapsedGroups)
          if (!next.delete(key)) {
            next.add(key)
          }
          return { collapsedGroups: next }
        })
    })
  },
  render: () => (
    <ConfirmationDialogProvider>
      <div className="bg-background p-3">
        <Sidebar />
      </div>
    </ConfirmationDialogProvider>
  )
})

/** Click, fold and hover freely: the bot on m4 has two chats, their workers, and asks for you. */
export const playground = base

/** The m4 bot's hover card, open. */
export const hoverCard = defineFixture({
  ...base,
  width: 700,
  interact: async (frame) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    const name = [...frame.querySelectorAll<HTMLElement>('[data-worktree-card-surface] *')].find(
      (element) => element.textContent === releaseBot.name
    )
    const box = name?.getBoundingClientRect()
    // The card opens on a pointer resting after real movement, so move twice.
    for (const dx of [0, 4]) {
      name?.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerType: 'mouse',
          clientX: (box?.left ?? 0) + 10 + dx,
          clientY: (box?.top ?? 0) + 5
        })
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
})
