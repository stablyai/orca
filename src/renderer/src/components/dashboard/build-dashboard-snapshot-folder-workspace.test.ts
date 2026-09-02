import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { buildDashboardSnapshot, type DashboardSnapshotState } from './build-dashboard-snapshot'
import { buildDashboardBucketCounts } from './build-dashboard-bucket-counts'

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
        expandedLeafId: null,
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
  it('keeps count-only projection aligned across local and remote workspaces', () => {
    const mixedState = state()
    const localTabId = 'local-tab'
    const localLeafId = '22222222-2222-4222-8222-222222222222'
    const localPaneKey = makePaneKey(localTabId, localLeafId)
    mixedState.repos = [
      {
        id: 'repo-1',
        path: '/repo-1',
        displayName: 'Local repo',
        badgeColor: '#000'
      }
    ] as unknown as DashboardSnapshotState['repos']
    mixedState.worktreesByRepo = {
      'repo-1': [
        {
          id: 'local-worktree',
          repoId: 'repo-1',
          path: '/repo-1/worktree',
          head: 'abc123',
          branch: 'main',
          isBare: false,
          isMainWorktree: false,
          displayName: 'Local worktree',
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
      ]
    } as unknown as DashboardSnapshotState['worktreesByRepo']
    mixedState.tabsByWorktree['local-worktree'] = [
      {
        id: localTabId,
        ptyId: 'pty-local',
        worktreeId: 'local-worktree',
        title: 'claude',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: NOW
      },
      {
        id: 'title-tab',
        ptyId: 'pty-title',
        worktreeId: 'local-worktree',
        title: '✦ Claude Code',
        customTitle: null,
        color: null,
        sortOrder: 1,
        createdAt: NOW
      }
    ]
    mixedState.terminalLayoutsByTabId[localTabId] = {
      root: { type: 'leaf', leafId: localLeafId },
      activeLeafId: localLeafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [localLeafId]: 'pty-local' }
    }
    mixedState.terminalLayoutsByTabId['title-tab'] = {
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: 'pty-title' }
    }
    mixedState.ptyIdsByTabId[localTabId] = ['pty-local']
    mixedState.ptyIdsByTabId['title-tab'] = ['pty-title']
    mixedState.runtimePaneTitlesByTabId['title-tab'] = { 1: '✦ Claude Code' }
    mixedState.agentStatusByPaneKey[localPaneKey] = {
      paneKey: localPaneKey,
      state: 'done',
      prompt: 'Review complete',
      updatedAt: NOW,
      stateStartedAt: NOW - 60_000,
      stateHistory: [],
      agentType: 'claude',
      tabId: localTabId,
      worktreeId: 'local-worktree'
    }
    mixedState.acknowledgedAgentsByPaneKey[localPaneKey] = NOW

    const snapshot = buildDashboardSnapshot(mixedState, NOW)
    const expected = { attention: 0, working: 0, done: 0, idle: 0 }
    for (const card of snapshot.cards) {
      expected[card.bucket] += 1
    }
    expect(
      snapshot.cards.find((card) => card.paneKey === makePaneKey('title-tab', LEAF_ID))
    ).toMatchObject({
      bucket: 'working',
      unseen: false,
      startedAt: 0
    })

    expect(buildDashboardBucketCounts(mixedState, NOW)).toEqual(expected)
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
    structuredState.agentStatusByPaneKey = {
      [PANE_KEY]: {
        ...entry(),
        state: 'done',
        sessionBoundary: true
      }
    }

    const snapshot = buildDashboardSnapshot(structuredState, NOW)
    const expected = { attention: 0, working: 0, done: 0, idle: 0 }
    for (const card of snapshot.cards) {
      expected[card.bucket] += 1
    }

    expect(snapshot.cards).toHaveLength(1)
    expect(snapshot.cards[0]).toMatchObject({ paneKey: PANE_KEY, bucket: 'done' })
    expect(buildDashboardBucketCounts(structuredState, NOW)).toEqual(expected)
  })

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
