import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { DashboardSnapshotState } from './build-dashboard-snapshot'
import {
  buildDashboardBucketCounts,
  createDashboardBucketCountsCache
} from './build-dashboard-bucket-counts'

const NOW = 1_000_000_000
// Freshness decay boundaries are exercised via generation bumps; the exact stale
// window belongs to the shared agent-status constants.
const AGENT_STALE_STEP = 60_000
const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const PANE_1 = makePaneKey('tab1', LEAF_1)
const PANE_2 = makePaneKey('tab2', LEAF_2)

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
    lastActivityAt: NOW
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
    createdAt: NOW
  }
}

function entry(paneKey: string, tabId: string, worktreeId: string): AgentStatusEntry {
  return {
    paneKey,
    state: 'working',
    prompt: 'do the thing',
    updatedAt: NOW,
    stateStartedAt: NOW - 5_000,
    stateHistory: [],
    agentType: 'claude',
    tabId,
    worktreeId
  }
}

function baseState(): DashboardSnapshotState {
  return {
    repos: [{ id: 'r1', path: '/r1', displayName: 'Repo One', badgeColor: '#000', addedAt: 1 }],
    worktreesByRepo: { r1: [worktree('w1'), worktree('w2')] },
    tabsByWorktree: { w1: [tab('tab1', 'w1')], w2: [tab('tab2', 'w2')] },
    agentStatusByPaneKey: {
      [PANE_1]: entry(PANE_1, 'tab1', 'w1'),
      [PANE_2]: entry(PANE_2, 'tab2', 'w2')
    },
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    terminalLayoutsByTabId: {
      tab1: {
        root: { type: 'leaf', leafId: LEAF_1 },
        activeLeafId: LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_1]: 'pty-tab1' }
      },
      tab2: {
        root: { type: 'leaf', leafId: LEAF_2 },
        activeLeafId: LEAF_2,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_2]: 'pty-tab2' }
      }
    },
    ptyIdsByTabId: { tab1: ['pty-tab1'], tab2: ['pty-tab2'] },
    runtimePaneTitlesByTabId: { tab1: { 0: 'shell' }, tab2: { 0: 'shell' } },
    acknowledgedAgentsByPaneKey: {},
    settings: null
  }
}

describe('buildDashboardBucketCounts per-worktree cache', () => {
  it('computes every worktree on the first call and none when nothing changed', () => {
    const cache = createDashboardBucketCountsCache()
    const state = baseState()
    const first = buildDashboardBucketCounts(state, NOW, cache, 1)
    expect(cache.lastComputedWorktreeIds.sort()).toEqual(['w1', 'w2'])
    expect(first.working).toBe(2)

    const second = buildDashboardBucketCounts(state, NOW + 1_000, cache, 1)
    expect(cache.lastComputedWorktreeIds).toEqual([])
    expect(second).toEqual(first)
  })

  it('recomputes only the worktree affected by an unrelated title write', () => {
    const cache = createDashboardBucketCountsCache()
    const state = baseState()
    buildDashboardBucketCounts(state, NOW, cache, 1)

    // A pane-title frame for w2's tab: new top-level map identity, only tab2 changed.
    const next: DashboardSnapshotState = {
      ...state,
      runtimePaneTitlesByTabId: { ...state.runtimePaneTitlesByTabId, tab2: { 0: 'sh' } }
    }
    const counts = buildDashboardBucketCounts(next, NOW + 500, cache, 1)
    expect(cache.lastComputedWorktreeIds).toEqual(['w2'])
    // Correctness: identical to a cold, uncached run over the same state.
    expect(counts).toEqual(buildDashboardBucketCounts(next, NOW + 500))
  })

  it('recomputes only the worktree affected by a status write', () => {
    const cache = createDashboardBucketCountsCache()
    const state = baseState()
    buildDashboardBucketCounts(state, NOW, cache, 1)

    const next: DashboardSnapshotState = {
      ...state,
      agentStatusByPaneKey: {
        ...state.agentStatusByPaneKey,
        [PANE_1]: { ...entry(PANE_1, 'tab1', 'w1'), prompt: 'new streamed prompt' }
      }
    }
    const counts = buildDashboardBucketCounts(next, NOW + 500, cache, 1)
    expect(cache.lastComputedWorktreeIds).toEqual(['w1'])
    expect(counts).toEqual(buildDashboardBucketCounts(next, NOW + 500))
  })

  it('recomputes every worktree when the freshness generation changes', () => {
    const cache = createDashboardBucketCountsCache()
    const state = baseState()
    buildDashboardBucketCounts(state, NOW, cache, 1)
    buildDashboardBucketCounts(state, NOW + AGENT_STALE_STEP, cache, 2)
    expect(cache.lastComputedWorktreeIds.sort()).toEqual(['w1', 'w2'])
  })

  it('drops cache rows for worktrees that leave the active set', () => {
    const cache = createDashboardBucketCountsCache()
    const state = baseState()
    buildDashboardBucketCounts(state, NOW, cache, 1)
    expect([...cache.byWorktree.keys()].sort()).toEqual(['w1', 'w2'])

    const next: DashboardSnapshotState = {
      ...state,
      worktreesByRepo: { r1: [worktree('w1')] }
    }
    buildDashboardBucketCounts(next, NOW + 500, cache, 1)
    expect([...cache.byWorktree.keys()]).toEqual(['w1'])
  })

  it('matches the uncached result for acknowledgement changes', () => {
    const cache = createDashboardBucketCountsCache()
    const state: DashboardSnapshotState = {
      ...baseState(),
      agentStatusByPaneKey: {
        [PANE_1]: { ...entry(PANE_1, 'tab1', 'w1'), state: 'done' },
        [PANE_2]: entry(PANE_2, 'tab2', 'w2')
      }
    }
    buildDashboardBucketCounts(state, NOW, cache, 1)
    const acked: DashboardSnapshotState = {
      ...state,
      acknowledgedAgentsByPaneKey: { [PANE_1]: NOW }
    }
    const counts = buildDashboardBucketCounts(acked, NOW + 500, cache, 1)
    expect(counts).toEqual(buildDashboardBucketCounts(acked, NOW + 500))
    // Rows don't depend on acks — the recount must not rebuild any row pipeline.
    expect(cache.lastComputedWorktreeIds).toEqual([])
  })
})
