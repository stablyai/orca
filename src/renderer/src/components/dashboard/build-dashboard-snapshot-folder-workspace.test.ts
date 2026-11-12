import {
  buildDashboardSnapshotFixture as buildDashboardSnapshot,
  buildDashboardBucketCountsFixture as buildDashboardBucketCounts
} from './dashboard-snapshot.test-fixture'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { DashboardSnapshotInput as DashboardSnapshotState } from './build-dashboard-snapshot'

const NOW = 2_000_000_000
const WORKSPACE_ID = folderWorkspaceKey('folder-1')
const TAB_ID = 'folder-tab'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

function folderWorkspace(): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Docs workspace',
    folderPath: '/workspace/docs',
    connectionId: 'ssh-1',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  }
}

function projectGroup(): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Documentation',
    parentPath: '/workspace',
    connectionId: 'ssh-1',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: NOW,
    updatedAt: NOW
  }
}

function tab(): TerminalTab {
  return {
    id: TAB_ID,
    ptyId: 'pty-folder',
    worktreeId: WORKSPACE_ID,
    title: 'codex',
    customTitle: 'Docs reviewer',
    color: null,
    sortOrder: 0,
    createdAt: NOW
  }
}

function entry(): AgentStatusEntry {
  return {
    paneKey: PANE_KEY,
    state: 'working',
    prompt: 'Review the docs',
    updatedAt: NOW,
    stateStartedAt: NOW - 60_000,
    stateHistory: [],
    agentType: 'codex',
    tabId: TAB_ID,
    worktreeId: WORKSPACE_ID
  }
}

function state(): DashboardSnapshotState {
  return {
    chatNames: new Map(),
    repos: [],
    worktreesByRepo: {},
    folderWorkspaces: [folderWorkspace()],
    projectGroups: [projectGroup()],
    tabsByWorktree: { [WORKSPACE_ID]: [tab()] },
    agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({ [PANE_KEY]: entry() })),

    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-folder' }
      }
    },
    ptyIdsByTabId: { [TAB_ID]: ['pty-folder'] },
    runtimePaneTitlesByTabId: {},
    acknowledgedAgentsByPaneKey: {},
    settings: null
  }
}

describe('buildDashboardSnapshot folder workspaces', () => {
  it('counts a remote row in its host workspace when a local tab ID collides', () => {
    const remoteState = state()
    remoteState.tabsByWorktree = { local: [{ ...tab(), worktreeId: 'local' }] }
    remoteState.agentStatusByPaneKey = acceptedAgentStatuses([
      [PANE_KEY, { ...entry(), connectionId: 'ssh-1' }]
    ])
    const snapshot = buildDashboardSnapshot(remoteState, NOW)
    expect(snapshot.cards.map((card) => card.worktreeId)).toEqual([WORKSPACE_ID])
    expect(buildDashboardBucketCounts(remoteState, NOW)).toEqual({
      attention: 0,
      working: 1,
      done: 0,
      idle: 0
    })
  })

  it('keeps done structured sessions visible when their tab exists only in unified tabs', () => {
    const structuredState = state()
    structuredState.tabsByWorktree = { [WORKSPACE_ID]: [] }
    structuredState.unifiedTabsByWorktree = {
      [WORKSPACE_ID]: [
        {
          id: TAB_ID,
          entityId: 'session-1',
          groupId: 'group-1',
          worktreeId: WORKSPACE_ID,
          contentType: 'agent-session',
          label: 'Codex Chat',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: NOW,
          isPinned: false,
          agentSessionAgent: 'codex'
        } satisfies Tab
      ]
    }
    structuredState.agentStatusByPaneKey = acceptedAgentStatuses(
      Object.entries({
        [PANE_KEY]: {
          ...entry(),
          state: 'done',
          sessionBoundary: true
        }
      })
    )

    const snapshot = buildDashboardSnapshot(structuredState, NOW)
    const expected = { attention: 0, working: 0, done: 0, idle: 0 }
    for (const card of snapshot.cards) {
      expected[card.bucket] += 1
    }

    expect(snapshot.cards).toHaveLength(1)
    expect(snapshot.cards[0]).toMatchObject({ paneKey: PANE_KEY, bucket: 'done' })
    expect(buildDashboardBucketCounts(structuredState, NOW)).toEqual(expected)
  })
})
