import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots, stubServerBots } from '../../component-fixtures/fixture-bots'
import { publishBots, setBotHostListing, type BotHostListing } from '@/lib/bot-catalog-snapshot'
import { useBots } from '@/lib/bot-catalog'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import WorktreeCard from '@/components/sidebar/workspace-card/surface/WorktreeCard'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { mascotAvatar, type BotMascotId } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeEnvironmentStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { BotRow } from './BotRow'
import { BOT_WORKSPACE_LINE_INDENT } from './BotSidebarEntry'
import { botListsUnderRow } from '../../../../shared/bots/bot-sidebar-tree'
import { chatPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'

// The PR 2 mock's list: two bots here, two on m4 air, one on linux 1, in the owner's order.
const now = Date.now()
const MIN = 60_000
const M4: ExecutionHostId = 'runtime:m4'
const LINUX: ExecutionHostId = 'runtime:linux'

const HOST_OF = new Map<string, ExecutionHostId>()
const hostOf = (owner: Bot): ExecutionHostId => HOST_OF.get(owner.id) ?? 'local'

function bot(
  id: string,
  name: string,
  mascot: BotMascotId,
  hostId: ExecutionHostId,
  agent: Bot['agent'] = 'claude'
): Bot {
  HOST_OF.set(id, hostId)
  // A host stores its own bots as `local`; the listing stamps the host that read them.
  return {
    id,
    name,
    hostId: 'local',
    folder: id,
    folderWorkspaceId: `fw-${id}`,
    agent,
    avatar: mascotAvatar(mascot),
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: `chat-${id}`,
    createdAt: 1,
    updatedAt: 1
  }
}

const release = bot('release', 'Release manager', 'H1', 'local', 'codex')
const triage = bot('triage', 'Issue triage bot', 'K2', M4)
const disk = bot('disk', 'Disk Space', 'D1', 'local')
const builder = bot('builder', 'Builder bot 1', 'F1', LINUX)
const docs = bot('docs', 'Docs bot', 'M1', M4, 'codex')
// No chat yet: its row says what it is for, from SOUL.md as m4 air reads it.
const planner = bot('planner', 'Planning bot', 'B1', M4)
const BOTS = [release, triage, disk, builder, docs, planner]
const SERVER_SOULS = {
  [planner.id]:
    "# Planning bot\n\nDrafts the team's weekly plan from Linear and the release notes.\n"
}

function chat(
  owner: Bot,
  fields: Partial<AgentStatusEntry> & Pick<AgentStatusEntry, 'state' | 'updatedAt'>
): AgentStatusEntry {
  return {
    paneKey: chatPaneKey(`chat-${owner.id}`),
    worktreeId: folderWorkspaceKey(owner.folderWorkspaceId),
    agentType: owner.agent,
    prompt: '',
    stateStartedAt: fields.updatedAt,
    stateHistory: [],
    ...fields
  }
}

const chats = [
  chat(release, {
    state: 'done',
    updatedAt: now - 2 * MIN,
    lastAssistantMessage: 'Cut v1.4.231, notes ready for review'
  }),
  chat(triage, {
    state: 'working',
    updatedAt: now - 10_000,
    toolName: 'Read',
    toolInput: 'ENG-42 comments'
  }),
  chat(disk, {
    state: 'done',
    updatedAt: now - 180 * MIN,
    lastAssistantMessage: '212 GB free, nothing to do'
  }),
  chat(builder, {
    state: 'working',
    updatedAt: now - 6 * MIN,
    lastAssistantMessage: 'Started 2 workers for the docs build'
  }),
  chat(docs, {
    state: 'done',
    updatedAt: now - 60 * MIN,
    lastAssistantMessage: 'Fixed the typo, opened orca#3412'
  })
]

function repo(id: string, displayName: string, executionHostId: ExecutionHostId): Repo {
  return {
    id,
    path: `/src/${displayName}`,
    displayName,
    badgeColor: '',
    addedAt: 1,
    executionHostId
  }
}

const REPOS = {
  orcaHere: repo('orca-local', 'orca', 'local'),
  orcaM4: repo('orca-m4', 'orca', M4),
  webLinux: repo('web-linux', 'web', LINUX),
  docsLinux: repo('docs-linux', 'docs', LINUX)
}

type Line = {
  id: string
  title: string
  repo: Repo
  agent: string
  state: AgentStatusEntry['state']
}

function worker({ id, title, repo: owner }: Line): Worktree {
  return {
    id,
    displayName: title,
    repoId: owner.id,
    path: `${owner.path}/${id}`,
    branch: id,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
}

// Each line's own computer, not its bot's: a bot on m4 air can start workers on linux 1 or here.
const WORKERS: Record<string, Line[]> = {
  release: [
    {
      id: 'notes',
      title: 'Draft release notes',
      repo: REPOS.orcaM4,
      agent: 'codex',
      state: 'done'
    },
    {
      id: 'bump',
      title: 'Bump version to 1.4.231',
      repo: REPOS.orcaHere,
      agent: 'codex',
      state: 'done'
    }
  ],
  triage: [
    {
      id: 'flaky',
      title: 'Fix flaky sidebar test',
      repo: REPOS.orcaM4,
      agent: 'claude',
      state: 'working'
    },
    {
      id: 'login',
      title: 'Repro login redirect loop',
      repo: REPOS.webLinux,
      agent: 'claude',
      state: 'working'
    },
    { id: 'label', title: 'Label new issues', repo: REPOS.orcaHere, agent: 'claude', state: 'done' }
  ],
  builder: [
    {
      id: 'site',
      title: 'Build docs site',
      repo: REPOS.docsLinux,
      agent: 'claude',
      state: 'working'
    },
    {
      id: 'links',
      title: 'Check broken links',
      repo: REPOS.docsLinux,
      agent: 'claude',
      state: 'working'
    }
  ]
}

const workerAgents: AgentStatusEntry[] = Object.values(WORKERS)
  .flat()
  .map((line) => ({
    paneKey: chatPaneKey(`worker-${line.id}`),
    worktreeId: line.id,
    agentType: line.agent,
    state: line.state,
    prompt: '',
    updatedAt: now - 10_000,
    stateStartedAt: now - 10_000,
    stateHistory: []
  }))

function environment(id: string, name: string): PublicKnownRuntimeEnvironment {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [],
    preferredEndpointId: id
  }
}

function runtimeStatus(id: string, up: boolean): RuntimeEnvironmentStatus {
  return { status: up ? createCompatibleRuntimeStatusResponse(id).result : null, checkedAt: 1 }
}

type Scene = {
  width: number
  m4Down?: boolean
  expanded?: readonly string[]
  active?: string
}

function homeOf(owner: Bot) {
  return makeFolderWorkspace({
    id: owner.folderWorkspaceId,
    name: owner.name,
    folderPath: `~/orca-bots/${owner.folder}`,
    executionHostId: owner.hostId,
    isUnread: owner === release
  })
}

const NONE: readonly string[] = []

function Sidebar({ width, m4Down = false, expanded = NONE, active }: Scene) {
  const stamped = useBots()
  const listed = BOTS.flatMap((owner) => stamped.find((entry) => entry.id === owner.id) ?? [])
  return (
    <div
      className="flex flex-col rounded-lg border border-border bg-worktree-sidebar py-1 pr-1.5 text-worktree-sidebar-foreground"
      style={{ width }}
    >
      {listed.map((owner) => {
        // A down host's bot is its row alone, as BotSidebarEntry draws it.
        const hostDown = m4Down && hostOf(owner) === M4
        const lines = hostDown ? [] : (WORKERS[owner.id] ?? [])
        const open = botListsUnderRow({ folded: !expanded.includes(owner.id), hostDown })
        const downHost = (line: Line) => m4Down && line.repo.executionHostId === M4
        const live = lines.filter((line) => !downHost(line) && line.state === 'working').length
        return (
          <div key={owner.id} className="flex flex-col">
            <BotRow
              bot={owner}
              home={homeOf(owner)}
              isActive={active === owner.id}
              onOpen={() => {}}
              fold={
                lines.length > 0
                  ? {
                      folded: !open,
                      total: lines.length,
                      counts: { permission: 0, working: live, failed: 0 },
                      onToggle: () => {}
                    }
                  : null
              }
            />
            {open ? (
              <div className="flex flex-col" style={{ marginLeft: BOT_WORKSPACE_LINE_INDENT }}>
                {lines.map((line) => (
                  <WorktreeCard
                    key={line.id}
                    worktree={worker(line)}
                    repo={line.repo}
                    isActive={false}
                    compactLine
                    lineOwnerHostId={owner.hostId}
                  />
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** `linuxOld`: linux 1 runs an Orca without bot listing, so its bots aren't read. */
function scene(scenes: Scene[], options: { m4Down?: boolean; linuxOld?: boolean } = {}) {
  const { m4Down = false, linuxOld = false } = options
  return defineFixture({
    width: scenes.reduce((sum, entry) => sum + entry.width + 16, 24),
    store: {
      runtimeEnvironments: [environment('m4', 'm4 air'), environment('linux', 'linux 1')],
      runtimeStatusByEnvironmentId: new Map([
        ['m4', runtimeStatus('m4', !m4Down)],
        ['linux', runtimeStatus('linux', true)]
      ]),
      repos: Object.values(REPOS),
      agentStatusByPaneKey: acceptedAgentStatuses(
        [...chats, ...workerAgents].map((entry) => [entry.paneKey, entry])
      )
    },
    setup: () => {
      const here = BOTS.filter((owner) => hostOf(owner) === 'local')
      const onM4 = BOTS.filter((owner) => hostOf(owner) === M4)
      const onLinux = BOTS.filter((owner) => hostOf(owner) === LINUX)
      const hosts: BotHostListing['hosts'] = [
        { hostId: 'local', state: 'live' },
        { hostId: M4, state: m4Down ? 'offline' : 'live' }
      ]
      setBotHostListing({
        hosts: linuxOld ? hosts : [...hosts, { hostId: LINUX, state: 'live' }],
        updateNeeded: linuxOld ? [LINUX] : []
      })
      const answer = { threadReplies: false, webhooks: undefined }
      stubBots(here)
      publishBots(onM4, answer, M4)
      if (!linuxOld) {
        publishBots(onLinux, answer, LINUX)
      }
      stubServerBots(
        { ...(m4Down ? {} : { m4: onM4 }), ...(linuxOld ? {} : { linux: onLinux }) },
        SERVER_SOULS
      )
    },
    render: () => (
      <ConfirmationDialogProvider>
        <div className="flex items-start gap-4 bg-background p-3">
          {scenes.map((entry) => (
            <div key={entry.width} className="flex flex-col gap-1.5">
              <div className="text-[11px] text-muted-foreground">{entry.width} px</div>
              <Sidebar {...entry} m4Down={m4Down} />
            </div>
          ))}
        </div>
      </ConfirmationDialogProvider>
    )
  })
}

/** 1 · One list for every computer: a server's bots carry its pill on their second line. */
export const mixed = scene([{ width: 280 }, { width: 220 }])

/** 2 · m4 air disconnected: its bots dim in place; each worker line keeps its own computer's state. */
export const disconnected = scene(
  [
    { width: 280, expanded: ['triage'] },
    { width: 220, expanded: ['triage'] }
  ],
  { m4Down: true }
)

function triageRow(frame: HTMLElement): HTMLElement | undefined {
  return [...frame.querySelectorAll<HTMLElement>('[data-worktree-card-surface]')].find((element) =>
    element.textContent?.includes('Issue triage bot')
  )
}

/** 2 · Hovering a disconnected server's bot: the usual card, naming its computer. */
export const disconnectedHover = defineFixture({
  ...scene([{ width: 280 }], { m4Down: true }),
  interact: async (frame) => {
    const name = triageRow(frame)?.querySelector<HTMLElement>('.flex-col')
    name?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
})

/** 2 · Right-click on a disconnected server's bot: everything off but Copy Path. */
export const disconnectedMenu = defineFixture({
  ...scene([{ width: 280 }], { m4Down: true }),
  interact: (frame) => {
    const row = triageRow(frame)
    const box = row?.getBoundingClientRect()
    row?.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        clientX: (box?.left ?? 0) + 40,
        clientY: (box?.top ?? 0) + 12
      })
    )
  }
})

/** 4 · Selected and expanded: each worker line names its computer when it isn't its bot's. */
export const expanded = scene([
  { width: 280, expanded: ['triage', 'release'], active: 'triage' },
  { width: 220, expanded: ['triage', 'release'], active: 'triage' }
])

/** 5 · linux 1 runs an older Orca: its bots aren't listed; New bot's computer picker asks for the update. */
export const olderServer = scene([{ width: 280 }, { width: 220 }], { linuxOld: true })
