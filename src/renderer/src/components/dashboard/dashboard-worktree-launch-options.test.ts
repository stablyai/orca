import { describe, expect, it } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
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
  it('uses each git workspace execution host instead of local detection', () => {
    const options = buildDashboardWorktreeLaunchOptions(
      state({
        repos: [
          {
            id: 'repo-ssh',
            path: '/repo-ssh',
            displayName: 'repo-ssh',
            badgeColor: 'blue',
            addedAt: 1,
            connectionId: 'ssh-1'
          },
          {
            id: 'repo-runtime',
            path: '/repo-runtime',
            displayName: 'repo-runtime',
            badgeColor: 'blue',
            addedAt: 1,
            executionHostId: 'runtime:hub-1'
          }
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
        card({ repoId: 'project:github:org/app', worktreeId: 'ssh-worktree', agentType: 'grok' }),
        card({
          repoId: 'project:github:org/app',
          worktreeId: 'runtime-worktree',
          agentType: 'aider'
        })
      ]
    )

    expect(options).toEqual({ 'ssh-worktree': ['grok'], 'runtime-worktree': ['aider'] })
  })
})
