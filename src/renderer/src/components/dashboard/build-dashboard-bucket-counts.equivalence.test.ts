import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import type { DashboardBucket } from '../../../../shared/dashboard-snapshot'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { EMPTY_WORKTREE_AGENT_ORCHESTRATION } from '../sidebar/worktree-agent-orchestration-batch'
import type { DashboardSnapshotState } from './build-dashboard-snapshot'
import {
  buildDashboardBucketCounts,
  createDashboardBucketCountsCache
} from './build-dashboard-bucket-counts'
import { selectDashboardOrchestration } from './dashboard-orchestration-selection'
import { dashboardRowBucketProjection } from './dashboard-row-bucket'
import { collectActiveDashboardWorkspaces } from './dashboard-snapshot-workspaces'
import { selectWorktreeAgentRowsCached } from './worktree-agent-rows-cache'

const BASE = 1_700_000_000_000
const STALE = AGENT_STATUS_STALE_AFTER_MS
const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const LEAF_3 = '33333333-3333-4333-8333-333333333333'
const PANE_1 = makePaneKey('tab1', LEAF_1)
const PANE_2 = makePaneKey('tab2', LEAF_2)
const FOLDER_WORKSPACE_ID = folderWorkspaceKey('folder-1')
const PANE_3 = makePaneKey('tab3', LEAF_3)

/**
 * Unmemoized reference walk, composed from the same shared primitives the sidebar
 * counts are defined by. Every assertion below pins the memoized builder to this.
 */
function oracleBucketCounts(
  state: DashboardSnapshotState,
  now: number
): Record<DashboardBucket, number> {
  const counts: Record<DashboardBucket, number> = {
    attention: 0,
    working: 0,
    done: 0,
    idle: 0
  }
  const activeWorktrees = collectActiveDashboardWorkspaces(state, false)
  const { singletonOrchestration, orchestrationByWorktree } = selectDashboardOrchestration(
    state,
    activeWorktrees
  )
  for (const { worktree } of activeWorktrees) {
    const rows = selectWorktreeAgentRowsCached({
      state,
      worktreeId: worktree.id,
      orchestration:
        singletonOrchestration ??
        orchestrationByWorktree?.get(worktree.id) ??
        EMPTY_WORKTREE_AGENT_ORCHESTRATION,
      now,
      generation: undefined
    })
    for (const row of rows) {
      if (row.rowSource === 'subagent') {
        continue
      }
      counts[dashboardRowBucketProjection(row, state.acknowledgedAgentsByPaneKey).bucket] += 1
    }
  }
  return counts
}

function worktree(id: string): Worktree {
  return {
    id,
    repoId: 'r1',
    path: `/r1/${id}`,
    head: 'abc123',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: BASE
  }
}

function tab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId,
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: BASE
  }
}

function entry(
  paneKey: string,
  tabId: string,
  worktreeId: string,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    paneKey,
    state: 'working',
    prompt: 'do the thing',
    updatedAt: BASE,
    stateStartedAt: BASE - 5_000,
    stateHistory: [],
    agentType: 'claude',
    tabId,
    worktreeId,
    ...overrides
  }
}

function leafLayout(tabId: string, leafId: string) {
  return {
    root: { type: 'leaf', leafId } as const,
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: `pty-${tabId}` }
  }
}

function folderWorkspace(): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Docs workspace',
    folderPath: '/workspace/docs',
    connectionId: null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: BASE,
    createdAt: BASE,
    updatedAt: BASE
  }
}

function projectGroup(): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Documentation',
    parentPath: '/workspace',
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: BASE,
    updatedAt: BASE
  }
}

function baseState(): DashboardSnapshotState {
  return {
    repos: [
      {
        id: 'r1',
        path: '/r1',
        displayName: 'Repo One',
        badgeColor: '#000',
        addedAt: 1
      }
    ],
    worktreesByRepo: { r1: [worktree('w1'), worktree('w2')] },
    folderWorkspaces: [folderWorkspace()],
    projectGroups: [projectGroup()],
    tabsByWorktree: {
      w1: [tab('tab1', 'w1')],
      w2: [tab('tab2', 'w2')],
      [FOLDER_WORKSPACE_ID]: [tab('tab3', FOLDER_WORKSPACE_ID)]
    },
    agentStatusByPaneKey: {
      [PANE_1]: entry(PANE_1, 'tab1', 'w1'),
      [PANE_2]: entry(PANE_2, 'tab2', 'w2', { state: 'done' }),
      [PANE_3]: entry(PANE_3, 'tab3', FOLDER_WORKSPACE_ID, {
        state: 'waiting'
      })
    },
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    terminalLayoutsByTabId: {
      tab1: leafLayout('tab1', LEAF_1),
      tab2: leafLayout('tab2', LEAF_2),
      tab3: leafLayout('tab3', LEAF_3)
    },
    ptyIdsByTabId: {
      tab1: ['pty-tab1'],
      tab2: ['pty-tab2'],
      tab3: ['pty-tab3']
    },
    runtimePaneTitlesByTabId: { tab1: { 0: 'shell' } },
    acknowledgedAgentsByPaneKey: {},
    settings: null
  } as unknown as DashboardSnapshotState
}

/**
 * One agent's clock crossing, walked in order through a single cache.
 *
 * `generation` models the store's `agentStatusEpoch`: it stays put until decay
 * may have shifted a bucket. `BASE + STALE` is the last instant an entry is
 * still fresh (`now - observedAt <= STALE`) and the only point where a cache
 * *hit* — not a recompute — has to return a freshness verdict.
 */
const CLOCK_WALK: { label: string; now: number; generation: number }[] = [
  { label: 'cold', now: BASE, generation: 1 },
  { label: 'last fresh instant (cache hit)', now: BASE + STALE, generation: 1 },
  { label: 'first stale instant', now: BASE + STALE + 1, generation: 2 },
  { label: 'long stale (cache hit)', now: BASE + STALE * 4, generation: 2 },
  { label: 'long stale (recomputed)', now: BASE + STALE * 4, generation: 3 }
]

type Mutation = {
  label: string
  apply: (state: DashboardSnapshotState) => DashboardSnapshotState
}

const MUTATIONS: Mutation[] = [
  { label: 'unchanged', apply: (state) => state },
  {
    label: 'acknowledgement written',
    apply: (state) => ({
      ...state,
      acknowledgedAgentsByPaneKey: { [PANE_2]: BASE + STALE * 8 }
    })
  },
  {
    label: 'unrelated pane-title frame',
    apply: (state) => ({
      ...state,
      runtimePaneTitlesByTabId: {
        ...state.runtimePaneTitlesByTabId,
        tab2: { 0: 'sh' }
      }
    })
  },
  {
    label: 'status write on one worktree',
    apply: (state) => ({
      ...state,
      agentStatusByPaneKey: {
        ...state.agentStatusByPaneKey,
        [PANE_1]: entry(PANE_1, 'tab1', 'w1', {
          prompt: 'streamed',
          state: 'blocked'
        })
      }
    })
  },
  {
    label: 'worktree leaves the active set',
    apply: (state) => ({ ...state, worktreesByRepo: { r1: [worktree('w1')] } })
  },
  {
    label: 'folder workspace archived',
    apply: (state) => ({
      ...state,
      folderWorkspaces: [{ ...folderWorkspace(), isArchived: true }]
    })
  },
  {
    label: 'project group renamed',
    apply: (state) => ({
      ...state,
      projectGroups: [{ ...projectGroup(), name: 'Renamed' }]
    })
  },
  {
    label: 'pty goes away',
    apply: (state) => ({
      ...state,
      ptyIdsByTabId: { tab2: ['pty-tab2'], tab3: ['pty-tab3'] }
    })
  }
]

describe('buildDashboardBucketCounts equivalence with the unmemoized walk', () => {
  it('matches the oracle for every mutation at every clock, sharing one cache', () => {
    for (const mutation of MUTATIONS) {
      const cache = createDashboardBucketCountsCache()
      for (const step of CLOCK_WALK) {
        const state = mutation.apply(baseState())
        expect(
          buildDashboardBucketCounts(state, step.now, cache, step.generation),
          `${mutation.label} @ ${step.label}`
        ).toEqual(oracleBucketCounts(state, step.now))
      }
    }
  })

  it('matches the oracle when mutations are applied cumulatively through one cache', () => {
    const cache = createDashboardBucketCountsCache()
    let state = baseState()
    for (const mutation of MUTATIONS) {
      state = mutation.apply(state)
      for (const step of CLOCK_WALK) {
        expect(
          buildDashboardBucketCounts(state, step.now, cache, step.generation),
          `${mutation.label} @ ${step.label}`
        ).toEqual(oracleBucketCounts(state, step.now))
      }
    }
  })

  it('serves the last-fresh instant from a cache hit and still decays one ms later', () => {
    const cache = createDashboardBucketCountsCache()
    const state = baseState()

    expect(buildDashboardBucketCounts(state, BASE, cache, 1).working).toBe(1)
    expect(cache.lastComputedWorktreeIds.length).toBe(3)

    // The boundary the earlier matrix never covered: a cache hit answering at the
    // exact instant `now - observedAt === STALE`, where the entry is still fresh.
    const atBoundary = buildDashboardBucketCounts(state, BASE + STALE, cache, 1)
    expect(cache.lastComputedWorktreeIds).toEqual([])
    expect(atBoundary.working).toBe(1)
    expect(atBoundary).toEqual(oracleBucketCounts(state, BASE + STALE))

    const pastBoundary = buildDashboardBucketCounts(state, BASE + STALE + 1, cache, 2)
    expect(pastBoundary.working).toBe(0)
    expect(pastBoundary).toEqual(oracleBucketCounts(state, BASE + STALE + 1))
  })

  it('returns the previous counts object when the four totals are unchanged', () => {
    const cache = createDashboardBucketCountsCache()
    const state = baseState()
    const first = buildDashboardBucketCounts(state, BASE, cache, 1)

    // A prompt stream on one pane: rows rebuild, totals do not move.
    const streamed: DashboardSnapshotState = {
      ...state,
      agentStatusByPaneKey: {
        ...state.agentStatusByPaneKey,
        [PANE_1]: entry(PANE_1, 'tab1', 'w1', { prompt: 'more output' })
      }
    }
    const second = buildDashboardBucketCounts(streamed, BASE + 1_000, cache, 1)
    expect(cache.lastComputedWorktreeIds).toEqual(['w1'])
    expect(second).toBe(first)

    const moved: DashboardSnapshotState = {
      ...state,
      agentStatusByPaneKey: {
        ...state.agentStatusByPaneKey,
        [PANE_1]: entry(PANE_1, 'tab1', 'w1', { state: 'blocked' })
      }
    }
    expect(buildDashboardBucketCounts(moved, BASE + 2_000, cache, 1)).not.toBe(first)
  })
})
