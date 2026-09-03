import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type * as DashboardSnapshotWorkspaces from './dashboard-snapshot-workspaces'
import type * as DashboardRowBucket from './dashboard-row-bucket'
import type { ActiveDashboardWorkspace } from './dashboard-snapshot-workspaces'

const collected = vi.hoisted(() => ({
  calls: 0,
  descriptors: 0,
  projections: 0
}))

vi.mock('./dashboard-snapshot-workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof DashboardSnapshotWorkspaces>()
  return {
    ...actual,
    collectActiveDashboardWorkspaces: (
      ...args: Parameters<typeof actual.collectActiveDashboardWorkspaces>
    ): ActiveDashboardWorkspace[] => {
      const workspaces = actual.collectActiveDashboardWorkspaces(...args)
      collected.calls += 1
      collected.descriptors += workspaces.length
      return workspaces
    }
  }
})

vi.mock('./dashboard-row-bucket', async (importOriginal) => {
  const actual = await importOriginal<typeof DashboardRowBucket>()
  return {
    ...actual,
    dashboardRowBucketProjection: (
      ...args: Parameters<typeof actual.dashboardRowBucketProjection>
    ) => {
      collected.projections += 1
      return actual.dashboardRowBucketProjection(...args)
    }
  }
})

import type { DashboardSnapshotState as SnapshotState } from './build-dashboard-snapshot'
import {
  buildDashboardBucketCounts,
  createDashboardBucketCountsCache
} from './build-dashboard-bucket-counts'

const NOW = 1_700_000_000_000
const WORKSPACE_COUNT = 400

function leafId(index: number): string {
  return `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`
}

function worktree(index: number): Worktree {
  return {
    id: `w${index}`,
    repoId: 'r1',
    path: `/r1/w${index}`,
    head: 'abc123',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    displayName: `w${index}`,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: index,
    lastActivityAt: NOW
  }
}

function tab(index: number): TerminalTab {
  return {
    id: `tab${index}`,
    ptyId: `pty-tab${index}`,
    worktreeId: `w${index}`,
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW
  }
}

function entry(index: number, prompt: string): AgentStatusEntry {
  return {
    paneKey: makePaneKey(`tab${index}`, leafId(index)),
    state: 'working',
    prompt,
    updatedAt: NOW,
    stateStartedAt: NOW - 5_000,
    stateHistory: [],
    agentType: 'claude',
    tabId: `tab${index}`,
    worktreeId: `w${index}`
  }
}

function largeState(): SnapshotState {
  const worktrees: Worktree[] = []
  const tabsByWorktree: Record<string, TerminalTab[]> = {}
  const agentStatusByPaneKey: Record<string, AgentStatusEntry> = {}
  const terminalLayoutsByTabId: Record<string, unknown> = {}
  const ptyIdsByTabId: Record<string, string[]> = {}
  for (let index = 0; index < WORKSPACE_COUNT; index += 1) {
    worktrees.push(worktree(index))
    tabsByWorktree[`w${index}`] = [tab(index)]
    agentStatusByPaneKey[makePaneKey(`tab${index}`, leafId(index))] = entry(index, 'do the thing')
    terminalLayoutsByTabId[`tab${index}`] = {
      root: { type: 'leaf', leafId: leafId(index) },
      activeLeafId: leafId(index),
      expandedLeafId: null,
      ptyIdsByLeafId: { [leafId(index)]: `pty-tab${index}` }
    }
    ptyIdsByTabId[`tab${index}`] = [`pty-tab${index}`]
  }
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
    worktreesByRepo: { r1: worktrees },
    folderWorkspaces: [],
    projectGroups: [],
    tabsByWorktree,
    agentStatusByPaneKey,
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    terminalLayoutsByTabId,
    ptyIdsByTabId,
    runtimePaneTitlesByTabId: {},
    acknowledgedAgentsByPaneKey: {},
    settings: null
  } as unknown as SnapshotState
}

beforeEach(() => {
  collected.calls = 0
  collected.descriptors = 0
  collected.projections = 0
})

describe('bucket-count work reuse', () => {
  it('allocates the descriptor list once across recomputes that leave the workspace slices alone', () => {
    const cache = createDashboardBucketCountsCache()
    const state = largeState()

    // Five recomputes driven by agent traffic: prompt streaming on one pane,
    // which is what actually invalidates the counts memo in the sidebar.
    for (let pass = 0; pass < 5; pass += 1) {
      const next: SnapshotState = {
        ...state,
        agentStatusByPaneKey: {
          ...state.agentStatusByPaneKey,
          [makePaneKey('tab0', leafId(0))]: entry(0, `streamed ${pass}`)
        }
      }
      buildDashboardBucketCounts(next, NOW + pass, cache, 1)
    }

    expect(collected.calls).toBe(1)
    expect(collected.descriptors).toBe(WORKSPACE_COUNT)
  })

  it('projects only the rows of the worktree whose inputs moved', () => {
    const cache = createDashboardBucketCountsCache()
    const state = largeState()
    buildDashboardBucketCounts(state, NOW, cache, 1)
    // Cold pass: one row per workspace.
    expect(collected.projections).toBe(WORKSPACE_COUNT)

    collected.projections = 0
    for (let pass = 0; pass < 5; pass += 1) {
      buildDashboardBucketCounts(
        {
          ...state,
          agentStatusByPaneKey: {
            ...state.agentStatusByPaneKey,
            [makePaneKey('tab0', leafId(0))]: entry(0, `streamed ${pass}`)
          }
        },
        NOW + pass,
        cache,
        1
      )
    }
    // One rebuilt worktree per pass, not the whole board.
    expect(collected.projections).toBe(5)
  })

  it('recounts every worktree without rebuilding rows when acknowledgements change', () => {
    const cache = createDashboardBucketCountsCache()
    const state = largeState()
    buildDashboardBucketCounts(state, NOW, cache, 1)

    collected.projections = 0
    const acked: SnapshotState = {
      ...state,
      acknowledgedAgentsByPaneKey: { [makePaneKey('tab0', leafId(0))]: NOW }
    }
    buildDashboardBucketCounts(acked, NOW + 1, cache, 1)
    expect(cache.lastComputedWorktreeIds).toEqual([])
    expect(collected.projections).toBe(WORKSPACE_COUNT)
  })

  it('rebuilds the descriptor list when any slice it reads changes identity', () => {
    const cache = createDashboardBucketCountsCache()
    const state = largeState()
    buildDashboardBucketCounts(state, NOW, cache, 1)
    expect(collected.calls).toBe(1)

    const slices: (keyof SnapshotState | 'projectGroups' | 'folderWorkspaces')[] = [
      'repos',
      'worktreesByRepo',
      'folderWorkspaces',
      'projectGroups'
    ]
    let previous: Record<string, unknown> = state as unknown as Record<string, unknown>
    for (const [index, slice] of slices.entries()) {
      const source = previous[slice]
      const next = {
        ...previous,
        [slice]: Array.isArray(source) ? [...source] : { ...(source as object) }
      }
      buildDashboardBucketCounts(next as unknown as SnapshotState, NOW, cache, 1)
      expect(collected.calls, `re-collects after ${slice} changes`).toBe(index + 2)
      previous = next
    }
  })

  it('does not memoize when the caller passes no cache', () => {
    const state = largeState()
    buildDashboardBucketCounts(state, NOW)
    buildDashboardBucketCounts(state, NOW)
    expect(collected.calls).toBe(2)
  })
})
