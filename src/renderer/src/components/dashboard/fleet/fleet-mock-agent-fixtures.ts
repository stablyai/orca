import type {
  DashboardBucket,
  DashboardCardDotState
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

export type MockRepo = 'orca' | 'orca-docs' | 'web-app' | 'notes'

type MockHost = { executionHostId: ExecutionHostId; hostLabel: string }

const BUILD_BOX: MockHost = { executionHostId: 'ssh:target-7f3a', hostLabel: 'build-box' }
const LINUX_RUNNER: MockHost = { executionHostId: 'ssh:target-91c2', hostLabel: 'linux-ci-runner' }

export type MockAgent = {
  id: number
  parent?: number
  agentType: AgentType
  bucket: DashboardBucket
  dotState: DashboardCardDotState
  unseen?: boolean
  repo: MockRepo
  worktree: string
  title: string
  message: string
  askSummary?: string
  startedMinutesAgo: number
  finishedMinutesAgo?: number
  changedMinutesAgo: number
  host?: MockHost
  subagents?: readonly [name: string, dotState: DashboardCardDotState][]
}

export const FLEET_MOCK_AGENTS: readonly MockAgent[] = [
  {
    id: 1,
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    repo: 'orca',
    worktree: 'fleet-projects',
    title: 'Group the fleet view by project',
    message: 'Two of four workers reported back. Holding the layout pass until the audit lands.',
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
    repo: 'orca',
    worktree: 'fleet-projects-model',
    title: 'Model projects from the dashboard snapshot',
    message: 'Projects are keyed by host and repo; six model tests pass.',
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
    repo: 'orca',
    worktree: 'fleet-projects-fixtures',
    title: 'Rework the fleet fixtures',
    message: 'The mock covers SSH hosts and cross-project workers. Folder workspaces are next.',
    askSummary: 'Add a folder workspace to the mock?',
    startedMinutesAgo: 86,
    changedMinutesAgo: 6
  },
  {
    id: 4,
    parent: 1,
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    repo: 'orca',
    worktree: 'fleet-projects-audit',
    title: 'Audit the location line on every node',
    message: 'Dispatched two checkers; merging their findings into one list.',
    startedMinutesAgo: 84,
    changedMinutesAgo: 10,
    subagents: [
      ['Explore: node location markup', 'done'],
      ['Explore: host badge rules', 'working']
    ]
  },
  {
    id: 5,
    parent: 4,
    agentType: 'gemini',
    bucket: 'done',
    dotState: 'done',
    unseen: true,
    repo: 'orca',
    worktree: 'fleet-audit-tree',
    title: 'Check the tree layout at wide widths',
    message: 'Every tree node shows its worktree; no truncation above 1,000px.',
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
    repo: 'orca',
    worktree: 'fleet-audit-linux',
    title: 'Check the outline layout on Linux',
    message: 'Running the fixture shots on the Linux runner; 3 of 5 done.',
    startedMinutesAgo: 79,
    changedMinutesAgo: 7,
    host: LINUX_RUNNER
  },
  {
    id: 7,
    parent: 1,
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    repo: 'orca-docs',
    worktree: 'fleet-view-docs',
    title:
      'Update the dashboard guide, the keyboard reference and the changelog so every fleet screenshot shows the new project grouping',
    message:
      'Rewrote the fleet section of the dashboard guide. Now retaking each screenshot against the new project headers, because three of them still show the flat team list that the project grouping replaced.',
    startedMinutesAgo: 70,
    changedMinutesAgo: 22
  },
  {
    id: 8,
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    repo: 'web-app',
    worktree: 'checkout-v2',
    title: 'Move checkout to the v2 payments API',
    message: 'The form and webhooks are merged. Waiting on the e2e rewrite.',
    startedMinutesAgo: 190,
    changedMinutesAgo: 12,
    host: BUILD_BOX
  },
  {
    id: 9,
    parent: 8,
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    repo: 'web-app',
    worktree: 'checkout-v2-form',
    title: 'Replace the card form with the hosted fields',
    message: 'Hosted fields render in all three themes; wiring the error states now.',
    startedMinutesAgo: 150,
    changedMinutesAgo: 4,
    host: BUILD_BOX,
    subagents: [
      ['Find every card form import', 'done'],
      ['Map hosted field events to form errors', 'working'],
      ['Check the dark theme contrast', 'working'],
      ['Draft the migration note', 'idle'],
      ['Review the error copy', 'waiting']
    ]
  },
  {
    id: 10,
    parent: 8,
    agentType: 'gemini',
    bucket: 'done',
    dotState: 'done',
    unseen: true,
    repo: 'web-app',
    worktree: 'checkout-v2-webhooks',
    title: 'Point the order webhooks at v2',
    message: 'Webhooks verify the v2 signature header; replay test passes.',
    startedMinutesAgo: 182,
    finishedMinutesAgo: 120,
    changedMinutesAgo: 120,
    host: BUILD_BOX
  },
  {
    id: 11,
    parent: 8,
    agentType: 'amp',
    bucket: 'attention',
    dotState: 'waiting',
    unseen: true,
    repo: 'web-app',
    worktree: 'checkout-v2-e2e',
    title: 'Rewrite the checkout e2e tests',
    message: 'Replaced three sleeps with a controllable clock; 200 iterations pass.',
    askSummary: 'Keep the 200-iteration soak in CI?',
    startedMinutesAgo: 185,
    changedMinutesAgo: 15,
    host: BUILD_BOX
  },
  {
    id: 12,
    agentType: 'cursor',
    bucket: 'working',
    dotState: 'working',
    repo: 'orca',
    worktree: 'chat-reader-memory',
    title: 'Investigate memory growth in the chat reader',
    message: 'Heap snapshots show retained transcript pages; testing an LRU cap of 50 pages.',
    startedMinutesAgo: 48,
    changedMinutesAgo: 9
  },
  {
    id: 13,
    agentType: 'codex',
    bucket: 'done',
    dotState: 'done',
    unseen: true,
    repo: 'orca',
    worktree: 'readme-typos',
    title: 'Fix typos in the README',
    message: 'Fixed four typos and one broken link in the README.',
    startedMinutesAgo: 34,
    finishedMinutesAgo: 27,
    changedMinutesAgo: 27
  },
  {
    id: 14,
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    repo: 'notes',
    worktree: 'q4-planning',
    title: 'Draft the Q4 planning doc',
    message: 'Pulled goals from last quarter; drafting the staffing section.',
    startedMinutesAgo: 25,
    changedMinutesAgo: 2
  },
  {
    id: 15,
    agentType: 'claude',
    bucket: 'idle',
    dotState: 'done',
    repo: 'notes',
    worktree: 'weekly-notes',
    title: "Summarize this week's meeting notes",
    message: 'Summarized five meetings into one page with action items.',
    startedMinutesAgo: 230,
    finishedMinutesAgo: 205,
    changedMinutesAgo: 205
  },
  {
    id: 16,
    agentType: 'claude',
    bucket: 'done',
    dotState: 'done',
    repo: 'notes',
    worktree: 'notes-archive',
    title: "Archive last quarter's meeting notes",
    message: 'Moved 42 notes into the Q3 archive and linked them from the index.',
    startedMinutesAgo: 320,
    finishedMinutesAgo: 260,
    changedMinutesAgo: 260
  },
  {
    id: 17,
    parent: 16,
    agentType: 'codex',
    bucket: 'done',
    dotState: 'done',
    repo: 'notes',
    worktree: 'notes-archive-sort',
    title: 'Sort the notes by project',
    message: 'Filed every note under one of six projects.',
    startedMinutesAgo: 315,
    finishedMinutesAgo: 290,
    changedMinutesAgo: 290
  },
  {
    id: 18,
    parent: 16,
    agentType: 'gemini',
    bucket: 'idle',
    dotState: 'done',
    repo: 'notes',
    worktree: 'notes-archive-tags',
    title: 'Tag decisions and owners',
    message: 'Tagged 17 decisions with their owners.',
    startedMinutesAgo: 314,
    finishedMinutesAgo: 280,
    changedMinutesAgo: 280
  }
]
