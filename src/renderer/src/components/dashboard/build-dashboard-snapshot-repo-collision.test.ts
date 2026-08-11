import { describe, expect, it } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'
import { buildDashboardSnapshot, type DashboardSnapshotState } from './build-dashboard-snapshot'

const NOW = 1_000_000_000
const REPO_ID = 'same-repo'

function repo(displayName: string, owner: Pick<Repo, 'connectionId' | 'executionHostId'>): Repo {
  return {
    id: REPO_ID,
    path: `/${displayName}`,
    displayName,
    badgeColor: '#000',
    addedAt: NOW,
    ...owner
  }
}

function worktree(
  id: string,
  owner: Pick<Worktree, 'hostId' | 'runtimeOwnerEnvironmentId'> = {}
): Worktree {
  return {
    id,
    repoId: REPO_ID,
    path: `/${id}`,
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
    lastActivityAt: NOW,
    ...owner
  }
}

function state(repos: Repo[], worktrees: Worktree[]): DashboardSnapshotState {
  return {
    repos,
    worktreesByRepo: { [REPO_ID]: worktrees },
    tabsByWorktree: {},
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {},
    acknowledgedAgentsByPaneKey: {},
    folderWorkspaces: [],
    projectGroups: [],
    detectedAgentIds: ['claude'],
    remoteDetectedAgentIds: { server: ['goose'] },
    runtimeDetectedAgentIds: { hub: ['codex'] },
    settings: null
  } as unknown as DashboardSnapshotState
}

function projectsByLabel(
  snapshot: ReturnType<typeof buildDashboardSnapshot>
): Record<string, string> {
  return Object.fromEntries(
    (snapshot.filterOptions?.projects ?? []).map(({ id, label }) => [label, id])
  )
}

describe('buildDashboardSnapshot same-id repo ownership', () => {
  it.each([false, true])(
    'joins local and paired-runtime worktrees once across catalog order (reversed=%s)',
    (reversed) => {
      const localRepo = repo('Local repo', { connectionId: null, executionHostId: 'local' })
      const runtimeRepo = repo('Runtime repo', {
        connectionId: null,
        executionHostId: 'runtime:hub'
      })
      const localWorktree = worktree('local-worktree', { hostId: 'local' })
      const runtimeWorktree = worktree('runtime-worktree', {
        hostId: 'ssh:server',
        runtimeOwnerEnvironmentId: 'hub'
      })
      const snapshot = buildDashboardSnapshot(
        state(
          reversed ? [runtimeRepo, localRepo] : [localRepo, runtimeRepo],
          reversed ? [runtimeWorktree, localWorktree] : [localWorktree, runtimeWorktree]
        ),
        NOW
      )

      expect(snapshot.workspaces).toHaveLength(2)
      expect(snapshot.workspaces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            worktreeId: 'local-worktree',
            repoId: 'same-repo@local',
            repoName: 'Local repo',
            executionHostId: 'local'
          }),
          expect.objectContaining({
            worktreeId: 'runtime-worktree',
            repoId: 'same-repo@runtime%3Ahub',
            repoName: 'Runtime repo',
            executionHostId: 'ssh:server'
          })
        ])
      )
      expect(projectsByLabel(snapshot)).toEqual({
        'Local repo': 'same-repo@local',
        'Runtime repo': 'same-repo@runtime%3Ahub'
      })
      expect(snapshot.launchableAgentsByWorktreeId).toEqual({
        'local-worktree': ['claude'],
        'runtime-worktree': ['codex']
      })
    }
  )

  it.each([false, true])(
    'joins local and SSH worktrees once across catalog order (reversed=%s)',
    (reversed) => {
      const localRepo = repo('Local repo', { connectionId: null, executionHostId: 'local' })
      const sshRepo = repo('SSH repo', {
        connectionId: 'server',
        executionHostId: 'ssh:server'
      })
      const localWorktree = worktree('local-worktree', { hostId: 'local' })
      const sshWorktree = worktree('ssh-worktree', { hostId: 'ssh:server' })
      const snapshot = buildDashboardSnapshot(
        state(
          reversed ? [sshRepo, localRepo] : [localRepo, sshRepo],
          reversed ? [sshWorktree, localWorktree] : [localWorktree, sshWorktree]
        ),
        NOW
      )

      expect(snapshot.workspaces).toHaveLength(2)
      expect(snapshot.workspaces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            worktreeId: 'local-worktree',
            repoId: 'same-repo@local',
            repoName: 'Local repo'
          }),
          expect.objectContaining({
            worktreeId: 'ssh-worktree',
            repoId: 'same-repo@ssh%3Aserver',
            repoName: 'SSH repo'
          })
        ])
      )
      expect(projectsByLabel(snapshot)).toEqual({
        'Local repo': 'same-repo@local',
        'SSH repo': 'same-repo@ssh%3Aserver'
      })
      expect(snapshot.launchableAgentsByWorktreeId).toEqual({
        'local-worktree': ['claude'],
        'ssh-worktree': ['goose']
      })
    }
  )

  it('omits an ownerless worktree when same-id repo ownership is unresolved', () => {
    const snapshot = buildDashboardSnapshot(
      state(
        [
          repo('Legacy repo', {}),
          repo('Local repo', { connectionId: null, executionHostId: 'local' })
        ],
        [worktree('legacy-worktree')]
      ),
      NOW
    )

    expect(snapshot.workspaces).toEqual([])
    expect(snapshot.filterOptions?.projects).toEqual([])
    expect(snapshot.launchableAgentsByWorktreeId).toEqual({})
  })
})
