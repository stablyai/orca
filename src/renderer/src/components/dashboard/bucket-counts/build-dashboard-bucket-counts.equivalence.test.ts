import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'

import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../../shared/project-group-types'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../../../shared/workspace-scope'
import '../../sidebar/workspace-card/activity/worktree-agent-orchestration-batch'

import type { DashboardSnapshotState } from '../snapshot/build-dashboard-snapshot'
import {
  buildDashboardBucketCounts,
  createDashboardBucketCountsCache
} from './build-dashboard-bucket-counts'

const BASE = 1_700_000_000_000
const STALE = AGENT_STATUS_STALE_AFTER_MS
const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'
const LEAF_3 = '33333333-3333-4333-8333-333333333333'
const PANE_1 = makePaneKey('tab1', LEAF_1)
const PANE_2 = makePaneKey('tab2', LEAF_2)
const FOLDER_WORKSPACE_ID = folderWorkspaceKey('folder-1')
const PANE_3 = makePaneKey('tab3', LEAF_3)

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

describe('buildDashboardBucketCounts equivalence with the unmemoized walk', () => {
  it('keeps the last-fresh instant working and decays one ms later', () => {
    const cache = createDashboardBucketCountsCache()
    const state = baseState()

    expect(buildDashboardBucketCounts(state, BASE, cache, 1).working).toBe(1)

    // At now-observedAt === STALE the cache still hits and the entry remains fresh.
    const atBoundary = buildDashboardBucketCounts(state, BASE + STALE, cache, 1)
    expect(atBoundary.working).toBe(1)

    const pastBoundary = buildDashboardBucketCounts(state, BASE + STALE + 1, cache, 2)
    expect(pastBoundary.working).toBe(0)
  })
})
