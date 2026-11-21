import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import type React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { publishBots } from '@/lib/bot-catalog-snapshot'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import WorktreeCard from '@/components/sidebar/workspace-card/surface/WorktreeCard'
import { structuredAgentSessionStatusPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-tab'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { Bot } from '../../../../shared/bot-types'
import type { ExternalConversationLink } from '../../../../shared/connectors/external-conversation-link'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { ConfirmationDialogProvider } from '../dismiss/confirmation/confirmation-dialog'
import { BotRow } from './BotRow'
import { BOT_WORKSPACE_LINE_INDENT } from './BotSidebarEntry'

const now = Date.now()
const MIN = 60_000

function bot(id: string, name: string, fields: Partial<Bot> = {}): Bot {
  return {
    id,
    name,
    hostId: 'local',
    folder: id,
    folderWorkspaceId: `fw-${id}`,
    agent: 'claude',
    avatar: null,
    paused: false,
    notifications: {
      needsPermission: true,
      taskComplete: true,
      couldNotFinish: true
    },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: `chat-${id}`,
    createdAt: 1,
    updatedAt: 1,
    ...fields
  }
}

const disk = bot('disk', 'Disk Space')
const triage = bot('triage', 'Triage bot')
const release = bot('release', 'Release manager')
const waiting = bot('waiting', 'Release manager')
const builder = bot('builder', 'Builder bot 1')
const paused = bot('paused', 'Disk Space', { paused: true })
const docs = bot('docs', 'Docs bot')
const linear = bot('linear', 'Triage bot')
const replying = bot('replying', 'Orca bot')
const cos = bot('cos', 'CoS')
const quiet = bot('quiet', 'Quarterly planning and investor update assistant')

function session(
  owner: Bot,
  sessionId: string,
  fields: Partial<AgentStatusEntry> & Pick<AgentStatusEntry, 'state' | 'updatedAt'>
): AgentStatusEntry {
  return {
    paneKey: structuredAgentSessionStatusPaneKey(sessionId),
    worktreeId: folderWorkspaceKey(owner.folderWorkspaceId),
    agentType: 'claude',
    prompt: '',
    stateStartedAt: fields.updatedAt,
    stateHistory: [],
    ...fields
  }
}

function thread(
  sessionId: string,
  source: ExternalConversationLink['source'],
  title: string,
  place: string,
  lastTurn: ExternalConversationLink['lastTurn'] = 'conversation'
): ExternalConversationLink {
  return {
    source,
    externalId: `T1:${sessionId}`,
    sessionId,
    agent: 'claude',
    paneKey: structuredAgentSessionStatusPaneKey(sessionId),
    title,
    place,
    lastTurn,
    createdAt: now - 60 * MIN
  }
}

const sessions = [
  session(disk, 'chat-disk', {
    state: 'done',
    updatedAt: now - 180 * MIN,
    lastAssistantMessage: '212 GB free, nothing to do'
  }),
  session(triage, 'chat-triage', {
    state: 'working',
    updatedAt: now - 10_000,
    toolName: 'Read',
    toolInput: 'ENG-42 comments'
  }),
  session(release, 'chat-release', {
    state: 'done',
    updatedAt: now - 60 * MIN,
    lastAssistantMessage: "Sure, I'll cut it after CI is green."
  }),
  session(release, 'slack-release', {
    state: 'done',
    updatedAt: now - 2 * MIN,
    lastAssistantMessage: 'Cut v1.4.231, notes ready for review'
  }),
  session(waiting, 'chat-waiting', {
    state: 'done',
    updatedAt: now - 240 * MIN,
    lastAssistantMessage: "I'll wait for Nora and remind you Friday."
  }),
  session(builder, 'chat-builder', {
    state: 'done',
    updatedAt: now - 6 * MIN,
    lastAssistantMessage: 'Started 2 workers for the docs fix.'
  }),
  session(docs, 'github-docs', {
    state: 'done',
    updatedAt: now - 60 * MIN,
    lastAssistantMessage: 'Fixed the typo and opened a PR'
  }),
  session(linear, 'linear-triage', {
    state: 'working',
    updatedAt: now - 10_000,
    toolName: 'Read',
    toolInput: 'src/auth/login.ts'
  }),
  session(replying, 'slack-replying', {
    state: 'working',
    updatedAt: now - 5_000,
    prompt: 'can you check the nightly?'
  }),
  session(paused, 'chat-paused', {
    state: 'done',
    updatedAt: now - 30 * MIN,
    lastAssistantMessage: 'Done'
  })
]

const repo: Repo = {
  id: 'bot-row-preview',
  path: '/preview/orca',
  displayName: 'orca',
  badgeColor: '',
  addedAt: 1
}
function worker(id: string, displayName: string): Worktree {
  return {
    id,
    displayName,
    repoId: repo.id,
    path: `/preview/orca/${id}`,
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

// The agents working in each worker line, as the line's logos and hover card read them.
const workerAgentRows: [string, string, string, AgentStatusEntry['state']][] = [
  ['flaky', 'flaky', 'claude', 'working'],
  ['docs', 'docs', 'codex', 'working'],
  ['sweep', 'sweep-1', 'claude', 'working'],
  ['sweep', 'sweep-2', 'claude', 'working'],
  ['sweep', 'sweep-3', 'codex', 'working'],
  ['sweep', 'sweep-4', 'gemini', 'blocked'],
  ['sweep', 'sweep-5', 'grok', 'working'],
  ['pair', 'pair-1', 'claude', 'working'],
  ['pair', 'pair-2', 'codex', 'working']
]
const workerAgents: AgentStatusEntry[] = workerAgentRows.map(
  ([worktreeId, pane, agentType, state]) => ({
    paneKey: structuredAgentSessionStatusPaneKey(`worker-${pane}`),
    worktreeId,
    agentType,
    state,
    prompt: '',
    updatedAt: now - 10_000,
    stateStartedAt: now - 10_000,
    stateHistory: []
  })
)

function home(owner: Bot, fields: Parameters<typeof makeFolderWorkspace>[0] = {}) {
  return makeFolderWorkspace({
    id: owner.folderWorkspaceId,
    name: owner.name,
    folderPath: `/bots/${owner.folder}`,
    ...fields
  })
}

const fold = (folded: boolean, working = 1) => ({
  folded,
  total: 2,
  counts: { permission: 0, working, failed: 0 },
  onToggle: () => {}
})

function row(owner: Bot, fields: Partial<React.ComponentProps<typeof BotRow>> = {}) {
  return <BotRow bot={owner} home={home(owner)} isActive={false} onOpen={() => {}} {...fields} />
}

const releaseRow = row(release, {
  home: home(release, {
    isUnread: true,
    externalConversations: [
      thread('slack-release', 'slack', 'Can you cut the release?', '#releases')
    ]
  })
})

const CASES: [string, number, React.ReactNode][] = [
  ['Idle bot', 280, row(disk)],
  ['Working in its Chat', 280, row(triage, { isActive: true })],
  ['3 threads, one unread', 280, releaseRow],
  [
    'Slack thread, latest turn typed in Orca',
    280,
    row(release, {
      home: home(release, {
        externalConversations: [
          thread('slack-release', 'slack', 'Can you cut the release?', '#releases', 'orca')
        ]
      })
    })
  ],
  [
    'Slack thread, no status yet',
    280,
    row(replying, {
      home: home(replying, {
        externalConversations: [
          thread('slack-replying', 'slack', 'can you check the nightly?', '#bots')
        ]
      })
    })
  ],
  ['Waiting on something', 280, row(waiting)],
  ['No activity, says its purpose', 280, row(cos, { fold: fold(false) })],
  ['Long name, no activity', 280, row(quiet)],
  [
    'Unread, workers folded, 3 new in Suggestions',
    280,
    row(release, { home: home(release, { isUnread: true }), fold: fold(true) })
  ],
  ...([true, false] as const).map((folded): [string, number, React.ReactNode] => [
    `Replying, workers ${folded ? 'folded' : 'unfolded'}`,
    280,
    row(replying, {
      home: home(replying, {
        externalConversations: [
          thread('slack-replying', 'slack', 'can you check the nightly?', '#bots')
        ]
      }),
      fold: fold(folded)
    })
  ]),
  [
    'Workers: one agent, two kinds, five agents of four kinds',
    280,
    <>
      {row(builder, { fold: fold(false) })}
      <div className="flex flex-col" style={{ marginLeft: BOT_WORKSPACE_LINE_INDENT }}>
        <WorktreeCard
          worktree={worker('flaky', 'Fix flaky sidebar test')}
          repo={repo}
          isActive={false}
          compactLine
        />
        <WorktreeCard
          worktree={worker('docs', 'Update install docs')}
          repo={repo}
          isActive={false}
          compactLine
        />
        <WorktreeCard
          worktree={worker('pair', 'Compare renderer fixes')}
          repo={repo}
          isActive={false}
          compactLine
        />
        <WorktreeCard
          worktree={worker('sweep', 'Parallel perf sweep, all panes')}
          repo={repo}
          isActive={false}
          compactLine
        />
      </div>
    </>
  ],
  ['Paused', 280, row(paused)],
  [
    'GitHub thread',
    280,
    row(docs, {
      home: home(docs, {
        externalConversations: [thread('github-docs', 'github', 'Typo in README', 'orca#3412')]
      })
    })
  ],
  [
    'Linear thread',
    280,
    row(linear, {
      home: home(linear, {
        externalConversations: [thread('linear-triage', 'linear', 'ENG-42 · Login loop', 'ENG-42')]
      })
    })
  ],
  [
    'Narrow sidebar (196px)',
    196,
    <>
      {releaseRow}
      {row(builder, { fold: fold(true) })}
      {row(
        { ...triage, name: 'Triage for launch posts and weekly digest' },
        { fold: fold(true, 0) }
      )}
      {row(release, { fold: fold(false) })}
      {row(cos, { fold: fold(false) })}
    </>
  ]
]

export const botRowCases = defineFixture({
  width: 940,
  store: {
    agentStatusByPaneKey: acceptedAgentStatuses(
      [...sessions, ...workerAgents].map((entry) => [entry.paneKey, entry])
    )
  },
  setup: () => {
    publishBots(
      [disk, triage, release, waiting, builder, paused, docs, linear, replying, cos, quiet],
      {
        threadReplies: false,
        webhooks: undefined,
        waits: {
          [waiting.id]: [{ label: "Nora's reply", by: nextFriday5pm() }]
        }
      }
    )
    stubSoulFiles({
      cos: "Keeps the team's week on track: plans, follow-ups and status.",
      quiet: "Drafts the quarterly plan and the investor update from the team's notes."
    })
    stubUpNextUnseen({ [triage.id]: 2, [release.id]: 3, [builder.id]: 1 })
  },
  render: () => (
    <ConfirmationDialogProvider>
      <div className="flex flex-wrap items-start gap-4 bg-background p-3">
        {CASES.map(([label, width, content]) => (
          <div key={label} className="flex flex-col gap-1.5">
            <div className="text-[11px] text-muted-foreground">{label}</div>
            <div
              data-case={label}
              className="flex flex-col rounded-lg border border-border bg-worktree-sidebar py-1 pr-1.5 text-worktree-sidebar-foreground"
              style={{ width }}
            >
              {content}
            </div>
          </div>
        ))}
      </div>
    </ConfirmationDialogProvider>
  )
})

function nextFriday5pm(): number {
  const date = new Date(now)
  date.setDate(date.getDate() + ((5 - date.getDay() + 7) % 7 || 7))
  date.setHours(17, 0, 0, 0)
  return date.getTime()
}

// The host's new Up next counts, answered without a runtime; other calls keep the default bridge.
function stubUpNextUnseen(unseen: Record<string, number>): void {
  const runtime = window.api.runtime
  Reflect.set(window.api, 'runtime', {
    ...runtime,
    call: (args: Parameters<typeof runtime.call>[0]) =>
      args.method === 'bots.upNext.unseen'
        ? Promise.resolve({ ok: true, result: { unseen } })
        : runtime.call(args)
  })
}

// Each bot's SOUL.md by its folder; other files keep the default bridge.
function stubSoulFiles(souls: Record<string, string>): void {
  const fs = window.api.fs
  const soul = (path: string) => souls[path.split('/').at(-2) ?? '']
  Reflect.set(window.api, 'fs', {
    ...fs,
    readFile: (args: Parameters<typeof fs.readFile>[0]) =>
      soul(args.filePath)
        ? Promise.resolve({ content: soul(args.filePath), isBinary: false })
        : fs.readFile(args)
  })
}
