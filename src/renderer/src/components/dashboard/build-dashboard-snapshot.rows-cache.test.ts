import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildDashboardSnapshot, type DashboardSnapshotState } from './build-dashboard-snapshot'
import { createWorktreeAgentRowsCache } from './worktree-agent-rows-cache'

const NOW = 1_000_000_000
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
    state: 'done',
    prompt: 'finish the task',
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

describe('buildDashboardSnapshot rows cache', () => {
  it('matches the uncached snapshot exactly across unrelated and targeted writes', () => {
    const cache = createWorktreeAgentRowsCache()
    const first = baseState()
    expect(buildDashboardSnapshot(first, NOW, { rowsCache: cache, rowsGeneration: 1 })).toEqual(
      buildDashboardSnapshot(first, NOW)
    )

    const titleWrite: DashboardSnapshotState = {
      ...first,
      runtimePaneTitlesByTabId: { ...first.runtimePaneTitlesByTabId, tab2: { 0: 'sh' } }
    }
    const cached = buildDashboardSnapshot(titleWrite, NOW + 500, {
      rowsCache: cache,
      rowsGeneration: 1
    })
    expect(cache.lastComputedWorktreeIds).toEqual(['w2'])
    expect(cached).toEqual(buildDashboardSnapshot(titleWrite, NOW + 500))
  })

  it('keeps card-level fields fresh (acks, workspace statuses) without recomputing rows', () => {
    const cache = createWorktreeAgentRowsCache()
    const state = baseState()
    const before = buildDashboardSnapshot(state, NOW, { rowsCache: cache, rowsGeneration: 1 })
    expect(before.cards.find((card) => card.paneKey === PANE_1)?.unseen).toBe(true)

    const acked: DashboardSnapshotState = {
      ...state,
      acknowledgedAgentsByPaneKey: { [PANE_1]: NOW }
    }
    const after = buildDashboardSnapshot(acked, NOW + 500, { rowsCache: cache, rowsGeneration: 1 })
    // Why asserted: acks and statuses are card-assembly inputs the rows cache deliberately
    // does not key — they must still flow into every rebuild.
    expect(cache.lastComputedWorktreeIds).toEqual([])
    expect(after.cards.find((card) => card.paneKey === PANE_1)?.unseen).toBe(false)
    expect(after).toEqual(buildDashboardSnapshot(acked, NOW + 500))
  })

  it('recomputes all worktrees when the freshness generation ticks', () => {
    const cache = createWorktreeAgentRowsCache()
    const state = baseState()
    buildDashboardSnapshot(state, NOW, { rowsCache: cache, rowsGeneration: 1 })
    buildDashboardSnapshot(state, NOW + 60_000, { rowsCache: cache, rowsGeneration: 2 })
    expect(cache.lastComputedWorktreeIds.sort()).toEqual(['w1', 'w2'])
  })
})
