import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { buildDashboardSnapshot, type DashboardSnapshotState } from './build-dashboard-snapshot'

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
    repos: [],
    worktreesByRepo: {},
    folderWorkspaces: [folderWorkspace()],
    projectGroups: [projectGroup()],
    tabsByWorktree: { [WORKSPACE_ID]: [tab()] },
    agentStatusByPaneKey: { [PANE_KEY]: entry() },
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-folder' }
      }
    },
    ptyIdsByTabId: { [TAB_ID]: ['pty-folder'] },
    runtimePaneTitlesByTabId: {},
    acknowledgedAgentsByPaneKey: {},
    settings: null
  } as unknown as DashboardSnapshotState
}

describe('buildDashboardSnapshot folder workspaces', () => {
  it('places folder-workspace agents in their real project group without git assumptions', () => {
    const sshState = state()
    sshState.sshTargetLabels = new Map([['ssh-1', 'openclaw']])
    const snapshot = buildDashboardSnapshot(sshState, NOW)

    expect(snapshot.cards).toHaveLength(1)
    expect(snapshot.cards[0]).toMatchObject({
      paneKey: PANE_KEY,
      repoId: 'folder-workspace:group-1',
      repoName: 'Documentation',
      worktreeId: WORKSPACE_ID,
      worktreeName: 'Docs workspace',
      workspaceKind: 'folder',
      hostKind: 'ssh',
      executionHostId: 'ssh:ssh-1',
      hostLabel: 'openclaw'
    })
    expect(snapshot.filterOptions?.projects).toEqual([
      { id: 'folder-workspace:group-1', label: 'Documentation' }
    ])
    expect(snapshot.workspaces).toEqual([
      expect.objectContaining({
        repoId: 'folder-workspace:group-1',
        worktreeId: WORKSPACE_ID,
        repoName: 'Documentation',
        worktreeName: 'Docs workspace',
        workspaceKind: 'folder',
        hostKind: 'ssh',
        executionHostId: 'ssh:ssh-1',
        hostLabel: 'openclaw'
      })
    ])
  })

  it('classifies a folder workspace from its own runtime host stamp', () => {
    const runtimeState = state()
    runtimeState.folderWorkspaces = [
      { ...folderWorkspace(), connectionId: null, executionHostId: 'runtime:environment-1' }
    ]
    runtimeState.projectGroups = [{ ...projectGroup(), connectionId: null }]
    runtimeState.runtimeEnvironments = [
      { id: 'environment-1', name: 'Build Mac' }
    ] as unknown as DashboardSnapshotState['runtimeEnvironments']

    const snapshot = buildDashboardSnapshot(runtimeState, NOW)

    expect(snapshot.cards[0].hostKind).toBe('remote')
    expect(snapshot.cards[0].executionHostId).toBe('runtime:environment-1')
    expect(snapshot.cards[0].hostLabel).toBe('Build Mac')
  })

  it('uses the user-facing host label override', () => {
    const runtimeState = state()
    runtimeState.folderWorkspaces = [
      { ...folderWorkspace(), connectionId: null, executionHostId: 'runtime:environment-1' }
    ]
    runtimeState.projectGroups = [{ ...projectGroup(), connectionId: null }]
    runtimeState.runtimeEnvironments = [
      { id: 'environment-1', name: 'Build Mac' }
    ] as unknown as DashboardSnapshotState['runtimeEnvironments']
    runtimeState.settings = {
      hostSettingOverrides: {
        'runtime:environment-1': { displayLabel: 'CI Builder' }
      }
    } as unknown as DashboardSnapshotState['settings']

    const snapshot = buildDashboardSnapshot(runtimeState, NOW)

    expect(snapshot.cards[0].hostLabel).toBe('CI Builder')
    expect(snapshot.workspaces?.[0].hostLabel).toBe('CI Builder')
  })
})
