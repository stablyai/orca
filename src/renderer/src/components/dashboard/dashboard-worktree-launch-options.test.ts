import { describe, expect, it } from 'vitest'
import { DASHBOARD_MAX_LAUNCH_WORKTREES } from '../../../../shared/dashboard-snapshot'
import type { DashboardCard, DashboardWorkspace } from '../../../../shared/dashboard-snapshot'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { buildDashboardWorktreeLaunchOptions } from './dashboard-worktree-launch-options'

type LaunchState = Parameters<typeof buildDashboardWorktreeLaunchOptions>[0]

function state(overrides: Partial<LaunchState> = {}): LaunchState {
  return {
    repos: [],
    worktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    detectedAgentIds: [],
    remoteDetectedAgentIds: {},
    runtimeDetectedAgentIds: {},
    settings: null,
    ...overrides
  }
}

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: 'pane-1',
    ptyId: 'pty-1',
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    task: 'Ship it',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    repoName: 'Orca',
    worktreeName: 'Dashboard',
    startedAt: 1,
    finishedAt: null,
    stateChangedAt: 1,
    unseen: false,
    ...overrides
  }
}

describe('buildDashboardWorktreeLaunchOptions', () => {
  it('stops at the bound the snapshot validator enforces', () => {
    const cards = Array.from({ length: DASHBOARD_MAX_LAUNCH_WORKTREES + 25 }, (_unused, index) =>
      card({ paneKey: `pane-${index}`, worktreeId: `worktree-${index}` })
    )

    const options = buildDashboardWorktreeLaunchOptions(
      state({ detectedAgentIds: ['codex'] }),
      cards
    )

    expect(Object.keys(options)).toHaveLength(DASHBOARD_MAX_LAUNCH_WORKTREES)
  })

  it('combines local detection with proven providers, honoring defaults and disabled agents', () => {
    const options = buildDashboardWorktreeLaunchOptions(
      state({
        detectedAgentIds: ['claude', 'codex'],
        settings: {
          defaultTuiAgent: 'codex',
          disabledTuiAgents: ['claude']
        } as LaunchState['settings']
      }),
      [card(), card({ paneKey: 'pane-2', agentType: 'gemini' })]
    )

    expect(options).toEqual({ 'worktree-1': ['codex', 'gemini'] })
  })

  it('publishes detected launch choices for workspaces without cards', () => {
    const workspace: DashboardWorkspace = {
      repoId: 'repo-1',
      worktreeId: 'empty-worktree',
      repoName: 'Orca',
      worktreeName: 'Empty',
      hostKind: 'local',
      executionHostId: 'local',
      workspaceKind: 'worktree'
    }
    const options = buildDashboardWorktreeLaunchOptions(
      state({ detectedAgentIds: ['claude', 'codex'] }),
      [],
      [workspace]
    )

    expect(options).toEqual({ 'empty-worktree': ['claude', 'codex'] })
  })

  it('uses each git workspace execution host instead of local detection', () => {
    const options = buildDashboardWorktreeLaunchOptions(
      state({
        repos: [
          { id: 'repo-ssh', connectionId: 'ssh-1' },
          { id: 'repo-runtime', executionHostId: 'runtime:hub-1' }
        ] as LaunchState['repos'],
        worktreesByRepo: {
          'repo-ssh': [{ id: 'ssh-worktree', repoId: 'repo-ssh' }],
          'repo-runtime': [{ id: 'runtime-worktree', repoId: 'repo-runtime' }]
        } as unknown as LaunchState['worktreesByRepo'],
        detectedAgentIds: ['claude'],
        remoteDetectedAgentIds: { 'ssh-1': ['grok'] },
        runtimeDetectedAgentIds: { 'hub-1': ['aider'] }
      }),
      [
        card({ repoId: 'repo-ssh', worktreeId: 'ssh-worktree', agentType: 'grok' }),
        card({ repoId: 'repo-runtime', worktreeId: 'runtime-worktree', agentType: 'aider' })
      ]
    )

    expect(options).toEqual({ 'ssh-worktree': ['grok'], 'runtime-worktree': ['aider'] })
  })

  it('resolves folder workspace detection through its project host', () => {
    const worktreeId = folderWorkspaceKey('folder-1')
    const options = buildDashboardWorktreeLaunchOptions(
      state({
        folderWorkspaces: [
          { id: 'folder-1', projectGroupId: 'group-1', connectionId: 'ssh-folder' }
        ] as LaunchState['folderWorkspaces'],
        projectGroups: [{ id: 'group-1' }] as LaunchState['projectGroups'],
        remoteDetectedAgentIds: { 'ssh-folder': ['goose'] }
      }),
      [card({ repoId: 'folder-workspace:group-1', worktreeId })]
    )

    expect(options).toEqual({ [worktreeId]: ['codex', 'goose'] })
  })
})
