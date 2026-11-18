import type {
  DashboardBucket,
  DashboardCard,
  DashboardCardDotState,
  DashboardSnapshot
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

export const FLEET_MOCK_NOW = Date.UTC(2026, 10, 18, 15, 0, 0)

const MINUTE = 60_000

type MockAgent = {
  id: number
  parent?: number
  agentType: AgentType
  bucket: DashboardBucket
  dotState: DashboardCardDotState
  unseen?: boolean
  repo: 'acme-billing' | 'orca' | 'acme-web'
  worktree: string
  title: string
  message: string
  askSummary?: string
  startedMinutesAgo: number
  finishedMinutesAgo?: number
  changedMinutesAgo: number
  host?: { executionHostId: ExecutionHostId; hostLabel: string }
}

const AGENTS: readonly MockAgent[] = [
  {
    id: 1,
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    repo: 'acme-billing',
    worktree: 'billing-v2',
    title: 'Ship billing v2 migration',
    message:
      'Two of four workers reported back. Holding the schema merge until the webhook refactor lands.',
    startedMinutesAgo: 95,
    changedMinutesAgo: 3
  },
  {
    id: 2,
    parent: 1,
    agentType: 'codex',
    bucket: 'done',
    dotState: 'done',
    unseen: true,
    repo: 'acme-billing',
    worktree: 'billing-v2-invoices',
    title: 'Migrate invoices table to the v2 schema',
    message: 'Migration and backfill are in place; 2,184 rows match the v1 totals.',
    startedMinutesAgo: 88,
    finishedMinutesAgo: 41,
    changedMinutesAgo: 41
  },
  {
    id: 3,
    parent: 1,
    agentType: 'claude',
    bucket: 'attention',
    dotState: 'waiting',
    unseen: true,
    repo: 'acme-billing',
    worktree: 'billing-v2-webhooks',
    title: 'Refactor payment webhook handlers',
    message:
      'Handlers verify signatures before parsing. The replay test needs a staging migration.',
    askSummary: 'Run pnpm db:migrate against staging?',
    startedMinutesAgo: 86,
    changedMinutesAgo: 6
  },
  {
    id: 4,
    parent: 1,
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    repo: 'acme-billing',
    worktree: 'billing-v2-audit',
    title: 'Audit every caller of the v1 billing API',
    message: 'Dispatched two scanners; merging their findings into one call-site list.',
    startedMinutesAgo: 84,
    changedMinutesAgo: 10
  },
  {
    id: 5,
    parent: 4,
    agentType: 'gemini',
    bucket: 'done',
    dotState: 'done',
    unseen: true,
    repo: 'acme-billing',
    worktree: 'billing-v2-audit-web',
    title: 'Scan the web client for v1 endpoints',
    message: 'Found 23 call sites in 9 files and attached the list to the task.',
    startedMinutesAgo: 80,
    finishedMinutesAgo: 52,
    changedMinutesAgo: 52
  },
  {
    id: 6,
    parent: 4,
    agentType: 'opencode',
    bucket: 'working',
    dotState: 'working',
    repo: 'acme-billing',
    worktree: 'billing-v2-audit-mobile',
    title: 'Scan the mobile client for v1 endpoints',
    message: 'Scanning React Native screens under app/billing; 61 of 140 files done.',
    startedMinutesAgo: 79,
    changedMinutesAgo: 79
  },
  {
    id: 7,
    parent: 1,
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    repo: 'acme-billing',
    worktree: 'billing-v2-docs',
    title:
      'Update the public billing API reference, the SDK migration guide and the changelog so every v1 endpoint links to its v2 replacement',
    message:
      'Rewrote the reference pages for invoices, subscriptions and refunds. Now cross-checking each code sample against the generated v2 OpenAPI schema, because three samples still pass amounts as floats instead of integer cents, which the v2 API rejects with a 422.',
    startedMinutesAgo: 70,
    changedMinutesAgo: 22
  },
  {
    id: 8,
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    repo: 'orca',
    worktree: 'stabilize-e2e',
    title: 'Stabilize the flaky e2e suite',
    message: 'Quarantine is merged. Waiting on the Linux bisect and the resize test rewrite.',
    startedMinutesAgo: 190,
    finishedMinutesAgo: 130,
    changedMinutesAgo: 12
  },
  {
    id: 9,
    parent: 8,
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    repo: 'orca',
    worktree: 'e2e-linux-bisect',
    title: 'Bisect timeouts on the Linux runner',
    message: 'Narrowed the regression to 14 commits; running the suite at the midpoint.',
    startedMinutesAgo: 150,
    changedMinutesAgo: 4,
    host: { executionHostId: 'ssh:linux-ci-runner', hostLabel: 'linux-ci-runner' }
  },
  {
    id: 10,
    parent: 8,
    agentType: 'gemini',
    bucket: 'done',
    dotState: 'done',
    unseen: true,
    repo: 'orca',
    worktree: 'e2e-quarantine',
    title: 'Quarantine the six flakiest specs',
    message: 'Moved six specs behind the @flaky tag and opened a tracking issue for each.',
    startedMinutesAgo: 182,
    finishedMinutesAgo: 120,
    changedMinutesAgo: 120
  },
  {
    id: 11,
    parent: 8,
    agentType: 'amp',
    bucket: 'working',
    dotState: 'working',
    repo: 'orca',
    worktree: 'e2e-resize-clock',
    title: 'Rewrite the terminal resize test with a fake clock',
    message:
      'Replaced three sleeps with a controllable clock; rerunning 200 iterations to confirm.',
    startedMinutesAgo: 185,
    changedMinutesAgo: 185
  },
  {
    id: 12,
    agentType: 'claude',
    bucket: 'idle',
    dotState: 'done',
    repo: 'acme-web',
    worktree: 'settings-layout',
    title: 'Explore a two-column settings layout',
    message: 'Sketched two layouts in the settings route; both keep the existing form controls.',
    startedMinutesAgo: 230,
    finishedMinutesAgo: 205,
    changedMinutesAgo: 205
  },
  {
    id: 13,
    agentType: 'codex',
    bucket: 'done',
    dotState: 'done',
    unseen: true,
    repo: 'acme-web',
    worktree: 'readme-typos',
    title: 'Fix typos in the README',
    message: 'Fixed four typos and one broken link in the README.',
    startedMinutesAgo: 34,
    finishedMinutesAgo: 27,
    changedMinutesAgo: 27
  },
  {
    id: 14,
    agentType: 'cursor',
    bucket: 'working',
    dotState: 'working',
    repo: 'orca',
    worktree: 'chat-reader-memory',
    title: 'Investigate memory growth in the chat reader',
    message: 'Heap snapshots show retained transcript pages; testing an LRU cap of 50 pages.',
    startedMinutesAgo: 48,
    changedMinutesAgo: 9
  }
]

function leafIdOf(id: number): string {
  return `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`
}

function paneKeyOf(id: number): string {
  return `tab-${id}:${leafIdOf(id)}`
}

function toCard(agent: MockAgent, now: number): DashboardCard {
  const ago = (minutes: number): number => now - minutes * MINUTE
  return {
    paneKey: paneKeyOf(agent.id),
    ptyId: `pty-${agent.id}`,
    agentType: agent.agentType,
    bucket: agent.bucket,
    dotState: agent.dotState,
    task: agent.title,
    conversationName: agent.title,
    lastAgentMessage: agent.message,
    askSummary: agent.askSummary,
    repoId: `repo-${agent.repo}`,
    worktreeId: `wt-${agent.worktree}`,
    tabId: `tab-${agent.id}`,
    leafId: leafIdOf(agent.id),
    parentPaneKey: agent.parent === undefined ? undefined : paneKeyOf(agent.parent),
    repoName: agent.repo,
    worktreeName: agent.worktree,
    hostKind: agent.host ? 'ssh' : 'local',
    executionHostId: agent.host?.executionHostId ?? 'local',
    hostLabel: agent.host?.hostLabel,
    workspaceKind: 'worktree',
    startedAt: ago(agent.startedMinutesAgo),
    finishedAt: agent.finishedMinutesAgo === undefined ? null : ago(agent.finishedMinutesAgo),
    stateChangedAt: ago(agent.changedMinutesAgo),
    unseen: agent.unseen ?? false
  }
}

export function buildFleetMockSnapshot(now: number): DashboardSnapshot {
  const repos = [...new Set(AGENTS.map((agent) => agent.repo))]
  return {
    generatedAt: now,
    cards: AGENTS.map((agent) => toCard(agent, now)),
    showIdle: true,
    filterOptions: {
      projects: repos.map((repo) => ({ id: `repo-${repo}`, label: repo })),
      workspaceStatuses: []
    }
  }
}
