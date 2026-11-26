// Sample rows for activity-inbox-v1.fixture.tsx: agents waiting, blocked and finished, and two bots.
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import type { AgentPaneThread } from '../threads/activity-thread-types'
import type { Bot } from '../../../../../shared/bot-types'
import { mascotAvatar } from '../../../../../shared/bot-avatar'
import type {
  AgentStatusEntry,
  AgentStatusState,
  AgentType
} from '../../../../../shared/agent-status/contracts/agent-status-types'

export const now = Date.now()
export const MIN = 60_000

const REPO = {
  id: 'inbox-repo',
  path: '/projects/orca',
  displayName: 'orca',
  badgeColor: 'var(--muted-foreground)',
  addedAt: 0
}

type ThreadSpec = {
  id: string
  title: string
  preview: string
  agent: AgentType
  state: AgentStatusState
  outcome?: 'failure' | 'unconfirmed'
  minutesAgo: number
  unread: boolean
  workspace: string
  repo?: boolean
}

function thread(spec: ThreadSpec): AgentPaneThread {
  const paneKey = `inbox-${spec.id}:leaf`
  const at = now - spec.minutesAgo * MIN
  const entry = {
    state: spec.state,
    prompt: '',
    updatedAt: at,
    stateStartedAt: at,
    paneKey,
    stateHistory: [],
    agentType: spec.agent,
    ...(spec.outcome ? { mainAgent: { state: 'done', outcome: spec.outcome } } : {})
  } as AgentStatusEntry
  const live = spec.state === 'waiting' || spec.state === 'blocked'
  return {
    paneKey,
    paneTitle: spec.title,
    worktree: {
      id: `inbox-wt-${spec.id}`,
      repoId: REPO.id,
      path: `/projects/orca/${spec.workspace}`,
      head: 'abc123',
      branch: spec.workspace,
      isBare: false,
      isMainWorktree: false,
      displayName: spec.workspace,
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    },
    repo: spec.repo === false ? null : REPO,
    tab: {
      id: `inbox-tab-${spec.id}`,
      ptyId: null,
      worktreeId: `inbox-wt-${spec.id}`,
      title: spec.agent,
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    },
    agentType: spec.agent,
    currentAgentState: live ? (spec.state as 'waiting' | 'blocked') : null,
    currentAgentEntry: live ? entry : null,
    ...(live ? {} : { paneEntry: entry }),
    responsePreview: spec.preview,
    latestTimestamp: at,
    latestEvent: null,
    events: [],
    unread: spec.unread
  }
}

// What v1 lists: agents waiting or blocked, and finished turns; only unread finishes show. Running agents never do.
export const THREADS = [
  thread({
    id: 'relay',
    title: 'Fix the relay reconnect timeout',
    preview: 'Allow `pnpm test:e2e --update-snapshots`?',
    agent: 'claude',
    state: 'blocked',
    minutesAgo: 1,
    unread: false,
    workspace: 'fix-relay-timeout'
  }),
  thread({
    id: 'mobile',
    title: 'Mobile tabs package',
    preview: 'Which test runner should the mobile package use: vitest (matches web) or jest?',
    agent: 'codex',
    state: 'waiting',
    minutesAgo: 6,
    unread: false,
    workspace: 'mobile-tabs'
  }),
  thread({
    id: 'resize',
    title: 'Flaky terminal resize test',
    preview: 'Fixed the flaky resize test and added a regression case.',
    agent: 'claude',
    state: 'done',
    minutesAgo: 2,
    unread: true,
    workspace: 'terminal-resize'
  }),
  thread({
    id: 'triage-chat',
    title: 'Triage today’s new Linear tickets',
    preview:
      'Tagged 14 new tickets and moved 3 to Needs triage. Two look like the same Windows relay bug.',
    agent: 'claude',
    state: 'done',
    minutesAgo: 9,
    unread: true,
    workspace: 'Triage bot',
    repo: false
  }),
  thread({
    id: 'lockfile',
    title: 'Audit the lockfile',
    preview: 'Context window ran out while reading pnpm-lock.yaml.',
    agent: 'codex',
    state: 'done',
    outcome: 'failure',
    minutesAgo: 40,
    unread: true,
    workspace: 'lockfile-audit'
  }),
  thread({
    id: 'copy',
    title: 'Settings copy to sentence case',
    preview: 'Renamed the settings sections to sentence case across 12 files.',
    agent: 'gemini',
    state: 'done',
    minutesAgo: 35,
    unread: false,
    workspace: 'ui-polish'
  })
]

export const triageBot: Bot = {
  ...fixtureCos,
  id: 'bot-triage',
  name: 'Triage bot',
  avatar: mascotAvatar('K2'),
  folderWorkspaceId: 'fw-triage'
}
export const releaseBot: Bot = {
  ...fixtureCos,
  id: 'bot-release',
  name: 'Release bot',
  avatar: mascotAvatar('R3'),
  folderWorkspaceId: 'fw-release'
}
