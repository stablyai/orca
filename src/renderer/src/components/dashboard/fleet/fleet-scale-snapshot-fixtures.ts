import type {
  DashboardBucket,
  DashboardCard,
  DashboardCardDotState,
  DashboardSnapshot
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

type ScaleHost = { executionHostId: ExecutionHostId; hostLabel: string }

type ScaleProject = {
  repo: string
  host?: ScaleHost
  folder?: true
}

const BUILD_BOX: ScaleHost = { executionHostId: 'ssh:target-7f3a', hostLabel: 'build-box' }
const GPU_BOX: ScaleHost = { executionHostId: 'ssh:target-a91e', hostLabel: 'gpu-runner' }

const PROJECTS: readonly ScaleProject[] = [
  { repo: 'orca' },
  { repo: 'orca' },
  { repo: 'orca-docs' },
  { repo: 'web-app', host: BUILD_BOX },
  { repo: 'api' },
  { repo: 'api', host: BUILD_BOX },
  { repo: 'mobile' },
  { repo: 'infra', host: GPU_BOX },
  { repo: 'design-system' },
  { repo: 'notes', folder: true }
]

const AGENT_TYPES: readonly AgentType[] = ['claude', 'codex', 'gemini', 'opencode', 'cursor', 'amp']

const TASKS = [
  'Migrate the settings page to the new form primitives',
  'Find why the terminal drops the first keystroke after a reconnect',
  'Write the release notes for the next beta',
  'Split the sync worker into a reader and a writer',
  'Audit every icon button for an accessible name',
  'Replace polling with a push subscription in the status bar',
  'Port the checkout e2e tests to the controllable clock',
  'Profile the chat list scroll on a 10k message transcript'
]

const MESSAGES = [
  'Read the existing implementation and listed four call sites to change.',
  'Tests pass locally; running the full suite on the Linux runner before reporting back.',
  'Two approaches left. Comparing their bundle size before picking one.',
  'Blocked on a flaky fixture; reproducing it with a fixed seed.'
]

const SUBAGENT_NAMES = [
  'Explore: call sites',
  'Explore: test coverage',
  'Check the dark theme',
  'Draft the summary',
  'Review the diff',
  'Search the issue tracker'
]

const MINUTE = 60_000

function seededRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

const DOT_STATE: Record<DashboardBucket, DashboardCardDotState> = {
  attention: 'waiting',
  working: 'working',
  done: 'done',
  idle: 'done'
}

function activeBucket(roll: number): DashboardBucket {
  return roll < 0.12 ? 'attention' : roll < 0.6 ? 'working' : roll < 0.88 ? 'done' : 'idle'
}

type ScaleMember = { parent?: number; bucket: DashboardBucket }

/** Size 3–5 teams are a lead with workers; larger ones put 2–3 leads between the root and the workers. */
function teamShape(size: number, settled: boolean, random: () => number): ScaleMember[] {
  const bucket = (): DashboardBucket =>
    settled ? (random() < 0.7 ? 'done' : 'idle') : activeBucket(random())
  const members: ScaleMember[] = [{ bucket: settled ? 'done' : 'working' }]
  const leads = size >= 6 ? 2 + Math.floor(random() * 2) : 0
  for (let lead = 1; lead <= leads; lead += 1) {
    members.push({ parent: 0, bucket: bucket() })
  }
  for (let index = members.length; index < size; index += 1) {
    members.push({ parent: leads === 0 ? 0 : 1 + ((index - leads - 1) % leads), bucket: bucket() })
  }
  return members
}

export type FleetScaleSnapshot = {
  snapshot: DashboardSnapshot
  /** Nodes Fleet renders with every project open: all cards except members of settled teams. */
  expectedFleetNodes: number
}

/** A fleet of `cardCount` agents; each index in `flipped` swaps that card between waiting and working. */
export function buildFleetScaleSnapshot(
  cardCount: number,
  now: number,
  flipped: ReadonlySet<number>
): FleetScaleSnapshot {
  const random = seededRandom(cardCount)
  const groups: { project: ScaleProject; members: ScaleMember[] }[] = []
  let planned = 0
  while (planned < cardCount) {
    const project = PROJECTS[Math.floor(random() * PROJECTS.length)]
    const remaining = cardCount - planned
    const members =
      remaining < 3 || random() < 0.35
        ? [{ bucket: activeBucket(random()) }]
        : teamShape(Math.min(remaining, 3 + Math.floor(random() * 10)), random() < 0.25, random)
    groups.push({ project, members })
    planned += members.length
  }

  const cards: DashboardCard[] = []
  let expectedFleetNodes = 0
  for (const { project, members } of groups) {
    const firstId = cards.length
    const buckets = members.map((member, offset) => {
      const bucket = member.bucket
      return flipped.has(firstId + offset)
        ? bucket === 'attention'
          ? 'working'
          : 'attention'
        : bucket
    })
    const settled = members.length > 1 && buckets.every((b) => b === 'done' || b === 'idle')
    expectedFleetNodes += settled ? 0 : members.length
    members.forEach((member, offset) => {
      const id = firstId + offset
      const bucket = buckets[offset]
      const startedAt = now - (20 + Math.floor(random() * 280)) * MINUTE
      const changedAt = startedAt + Math.floor(random() * 15) * MINUTE
      const subagentCount = random() < 0.18 ? 1 + Math.floor(random() * 6) : 0
      const task = TASKS[id % TASKS.length]
      cards.push({
        paneKey: `scale-tab-${id}:leaf-${id}`,
        ptyId: `scale-pty-${id}`,
        agentType: AGENT_TYPES[id % AGENT_TYPES.length],
        bucket,
        dotState: DOT_STATE[bucket],
        task,
        conversationName: `Scale agent ${id}: ${task}`,
        lastAgentMessage: MESSAGES[id % MESSAGES.length],
        askSummary:
          bucket === 'attention' ? 'Approve the plan before I edit shared files?' : undefined,
        repoId: `scale-repo-${project.repo}`,
        worktreeId: `scale-wt-${id}`,
        tabId: `scale-tab-${id}`,
        leafId: `leaf-${id}`,
        parentPaneKey:
          member.parent === undefined
            ? undefined
            : `scale-tab-${firstId + member.parent}:leaf-${firstId + member.parent}`,
        repoName: project.repo,
        worktreeName: `${project.repo}-task-${id}`,
        hostKind: project.host ? 'ssh' : 'local',
        executionHostId: project.host?.executionHostId ?? 'local',
        hostLabel: project.host?.hostLabel,
        workspaceKind: project.folder ? 'folder' : 'worktree',
        subagents:
          subagentCount === 0
            ? undefined
            : Array.from({ length: subagentCount }, (_, index) => ({
                id: `scale-${id}-sub-${index}`,
                name: SUBAGENT_NAMES[(id + index) % SUBAGENT_NAMES.length],
                dotState: index % 3 === 0 ? 'done' : 'working'
              })),
        startedAt,
        finishedAt: bucket === 'done' || bucket === 'idle' ? changedAt : null,
        stateChangedAt: flipped.has(id) ? now : changedAt,
        unseen: bucket === 'done' && id % 2 === 0
      })
    })
  }
  return {
    snapshot: {
      generatedAt: now,
      cards,
      showIdle: true,
      filterOptions: {
        projects: [...new Set(PROJECTS.map((project) => project.repo))].map((repo) => ({
          id: `scale-repo-${repo}`,
          label: repo
        })),
        workspaceStatuses: []
      },
      repoIconsByRepoId: {}
    },
    expectedFleetNodes
  }
}
