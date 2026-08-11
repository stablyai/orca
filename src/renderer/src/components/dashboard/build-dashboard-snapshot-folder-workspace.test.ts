import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { FolderWorkspace, ProjectGroup, TerminalTab } from '../../../../shared/types'
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
    const snapshot = buildDashboardSnapshot(state(), NOW)

    expect(snapshot.cards).toHaveLength(1)
    expect(snapshot.cards[0]).toMatchObject({
      paneKey: PANE_KEY,
      repoId: 'folder-workspace:group-1',
      repoName: 'Documentation',
      worktreeId: WORKSPACE_ID,
      worktreeName: 'Docs workspace',
      workspaceKind: 'folder',
      hostKind: 'ssh',
      executionHostId: 'ssh:ssh-1'
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
        executionHostId: 'ssh:ssh-1'
      })
    ])
  })

  it('classifies a folder workspace from its own runtime host stamp', () => {
    const runtimeState = state()
    runtimeState.folderWorkspaces = [
      { ...folderWorkspace(), connectionId: null, executionHostId: 'runtime:environment-1' }
    ]
    runtimeState.projectGroups = [{ ...projectGroup(), connectionId: null }]

    const snapshot = buildDashboardSnapshot(runtimeState, NOW)

    expect(snapshot.cards[0].hostKind).toBe('remote')
    expect(snapshot.cards[0].executionHostId).toBe('runtime:environment-1')
  })

  it('classifies an explicit-local folder as local under an SSH group', () => {
    const localState = state()
    localState.folderWorkspaces = [{ ...folderWorkspace(), connectionId: null }]
    localState.projectGroups = [
      { ...projectGroup(), executionHostId: 'ssh:ssh-1', connectionId: 'ssh-1' }
    ]

    const snapshot = buildDashboardSnapshot(localState, NOW)

    expect(snapshot.cards[0].hostKind).toBe('local')
    expect(snapshot.cards[0].executionHostId).toBe('local')
  })

  it.each([false, true])(
    'omits same-id folders when their owner cannot be represented by the dashboard key (reversed=%s)',
    (reversed) => {
      const collisionState = state()
      const local = { ...folderWorkspace(), connectionId: null, executionHostId: 'local' as const }
      const ssh = {
        ...folderWorkspace(),
        connectionId: 'ssh-1',
        executionHostId: 'ssh:ssh-1' as const
      }
      collisionState.folderWorkspaces = reversed ? [ssh, local] : [local, ssh]
      collisionState.projectGroups = [
        { ...projectGroup(), connectionId: null, executionHostId: 'local' },
        { ...projectGroup(), connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' }
      ]

      const snapshot = buildDashboardSnapshot(collisionState, NOW)

      expect(snapshot.cards).toEqual([])
      expect(snapshot.workspaces).toEqual([])
      expect(snapshot.filterOptions?.projects).toEqual([])
      expect(snapshot.launchableAgentsByWorktreeId).toEqual({})
    }
  )

  it('omits duplicate legacy folders from count-only snapshots without group catalogs', () => {
    const collisionState = state()
    collisionState.folderWorkspaces = [folderWorkspace(), folderWorkspace()]
    collisionState.projectGroups = undefined

    const snapshot = buildDashboardSnapshot(collisionState, NOW, {
      includeCardDetails: false,
      includeFilterOptions: false
    })

    expect(snapshot.cards).toEqual([])
  })

  it('associates a unique folder with the project group on the same owner', () => {
    const ownerState = state()
    ownerState.folderWorkspaces = [
      { ...folderWorkspace(), connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' }
    ]
    ownerState.projectGroups = [
      {
        ...projectGroup(),
        name: 'Local documentation',
        connectionId: null,
        executionHostId: 'local'
      },
      {
        ...projectGroup(),
        name: 'Remote documentation',
        connectionId: 'ssh-1',
        executionHostId: 'ssh:ssh-1'
      }
    ]

    const snapshot = buildDashboardSnapshot(ownerState, NOW)

    expect(snapshot.cards[0]).toMatchObject({
      repoName: 'Remote documentation',
      executionHostId: 'ssh:ssh-1'
    })
  })

  it('uses physical source provenance to associate paired-runtime groups', () => {
    const ownerState = state()
    ownerState.folderWorkspaces = [
      {
        ...folderWorkspace(),
        executionHostId: 'runtime:hub',
        runtimeSourceExecutionHostId: 'ssh:ssh-1'
      }
    ]
    ownerState.projectGroups = [
      {
        ...projectGroup(),
        name: 'Hub local documentation',
        connectionId: null,
        executionHostId: 'runtime:hub',
        runtimeSourceExecutionHostId: 'local'
      },
      {
        ...projectGroup(),
        name: 'Hub SSH documentation',
        executionHostId: 'runtime:hub',
        runtimeSourceExecutionHostId: 'ssh:ssh-1'
      }
    ]

    const snapshot = buildDashboardSnapshot(ownerState, NOW)

    expect(snapshot.cards[0]).toMatchObject({
      repoName: 'Hub SSH documentation',
      hostKind: 'remote',
      executionHostId: 'runtime:hub'
    })
  })

  it.each([false, true])(
    'owner-qualifies project identities for same-id groups (reversed=%s)',
    (reversed) => {
      const ownerState = state()
      const localFolder = {
        ...folderWorkspace(),
        connectionId: null,
        executionHostId: 'local' as const
      }
      const sshFolder = {
        ...folderWorkspace(),
        id: 'folder-2',
        name: 'Remote workspace',
        connectionId: 'ssh-1',
        executionHostId: 'ssh:ssh-1' as const
      }
      const localGroup = {
        ...projectGroup(),
        name: 'Local documentation',
        connectionId: null,
        executionHostId: 'local' as const
      }
      const sshGroup = {
        ...projectGroup(),
        name: 'Remote documentation',
        connectionId: 'ssh-1',
        executionHostId: 'ssh:ssh-1' as const
      }
      ownerState.folderWorkspaces = reversed ? [sshFolder, localFolder] : [localFolder, sshFolder]
      ownerState.projectGroups = reversed ? [sshGroup, localGroup] : [localGroup, sshGroup]

      const snapshot = buildDashboardSnapshot(ownerState, NOW)
      const projects = snapshot.filterOptions?.projects ?? []

      expect(projects.map((project) => project.label).sort()).toEqual([
        'Local documentation',
        'Remote documentation'
      ])
      expect(new Set(projects.map((project) => project.id))).toHaveProperty('size', 2)
    }
  )

  it.each(['folder', 'group'] as const)(
    'omits contradictory %s owner metadata',
    (contradiction) => {
      const contradictoryState = state()
      contradictoryState.folderWorkspaces = [
        {
          ...folderWorkspace(),
          ...(contradiction === 'folder'
            ? { connectionId: 'ssh-1', executionHostId: 'local' as const }
            : { connectionId: undefined, executionHostId: undefined })
        }
      ]
      contradictoryState.projectGroups = [
        {
          ...projectGroup(),
          ...(contradiction === 'group'
            ? { connectionId: 'ssh-1', executionHostId: 'local' as const }
            : {})
        }
      ]

      const snapshot = buildDashboardSnapshot(contradictoryState, NOW)

      expect(snapshot.cards).toEqual([])
      expect(snapshot.workspaces).toEqual([])
      expect(snapshot.launchableAgentsByWorktreeId).toEqual({})
    }
  )
})
