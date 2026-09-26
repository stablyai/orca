// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  mergeWorktreesForHost,
  worktreeHostMatchOptions
} from '@/store/slices/worktrees/listing/worktree-host-ownership'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getNotificationWorkspaceLabels } from './terminal-notification-state'

function stateWithWorkspace() {
  return {
    ...useAppStore.getInitialState(),
    worktreesByRepo: { repo: [makeWorktree({ id: 'wt', repoId: 'repo', displayName: 'Feature' })] },
    repos: [
      {
        id: 'repo',
        displayName: 'Orca',
        path: '/orca',
        connectionId: null,
        badgeColor: 'blue',
        addedAt: 0
      }
    ]
  }
}

describe('notification workspace labels', () => {
  it.each(['local', 'ssh:server', 'runtime:server'] as const)(
    'carries provenance for worktrees on %s',
    (hostId) => {
      const state = stateWithWorkspace()
      state.worktreesByRepo.repo = [
        makeWorktree({
          id: 'wt',
          repoId: 'repo',
          hostId,
          cliProvenance: { kind: 'created-by-cli', createdAt: 1 }
        })
      ]
      expect(getNotificationWorkspaceLabels(state, 'worktree:wt')).toMatchObject({
        workspaceOrigin: 'cli'
      })
      state.worktreesByRepo.repo = [
        makeWorktree({ id: 'wt', repoId: 'repo', hostId, orcaCreationSource: 'cli' })
      ]
      expect(getNotificationWorkspaceLabels(state, 'wt')).toMatchObject({ workspaceOrigin: 'cli' })
    }
  )

  it('includes the only project without reading agent inventories', () => {
    const state = stateWithWorkspace()
    Object.defineProperty(state, 'agentStatusByPaneKey', {
      get() {
        throw new Error('agent scan')
      }
    })
    Object.defineProperty(state, 'retainedAgentsByPaneKey', {
      get() {
        throw new Error('retained scan')
      }
    })
    expect(getNotificationWorkspaceLabels(state, 'wt')).toEqual({
      repoLabel: 'Orca',
      worktreeLabel: 'Feature'
    })
    expect(getNotificationWorkspaceLabels(state, 'worktree:wt')).toEqual({
      repoLabel: 'Orca',
      worktreeLabel: 'Feature'
    })
  })

  it('keeps labels for remote Git workspaces', () => {
    const state = stateWithWorkspace()
    state.worktreesByRepo.repo = [
      makeWorktree({
        id: 'remote',
        repoId: 'repo',
        hostId: 'ssh:server',
        displayName: 'Remote feature'
      })
    ]
    expect(getNotificationWorkspaceLabels(state, 'remote')).toEqual({
      repoLabel: 'Orca',
      worktreeLabel: 'Remote feature'
    })
  })

  it.each([undefined, 'ssh:server'] as const)(
    'resolves folder and project names on host %s',
    (executionHostId) => {
      const state = stateWithWorkspace()
      state.folderWorkspaces = [
        makeFolderWorkspace({
          id: 'folder-id',
          projectGroupId: 'group',
          name: 'Website',
          executionHostId
        })
      ]
      state.projectGroups = [
        {
          id: 'group',
          name: 'Personal',
          executionHostId,
          parentPath: null,
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 0,
          updatedAt: 0
        }
      ]
      expect(getNotificationWorkspaceLabels(state, 'folder:folder-id')).toEqual({
        repoLabel: 'Personal',
        worktreeLabel: 'Website'
      })
      state.projectGroups = []
      expect(getNotificationWorkspaceLabels(state, 'folder:folder-id')).toEqual({
        repoLabel: undefined,
        worktreeLabel: 'Website'
      })
    }
  )

  it.each([false, true])(
    'qualifies project groups by the folder host (legacy SSH: %s)',
    (legacy) => {
      const state = stateWithWorkspace()
      state.folderWorkspaces = [
        makeFolderWorkspace({
          id: 'remote-folder',
          name: 'Remote folder',
          projectGroupId: 'shared',
          ...(legacy ? { connectionId: 'server' } : { executionHostId: 'ssh:server' as const })
        })
      ]
      state.projectGroups = (['local', 'ssh:server'] as const).map((executionHostId) => ({
        id: 'shared',
        name: executionHostId === 'local' ? 'Local group' : 'Remote group',
        executionHostId,
        parentPath: null,
        parentGroupId: null,
        createdFrom: 'manual' as const,
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0
      }))
      expect(getNotificationWorkspaceLabels(state, 'folder:remote-folder')).toEqual({
        repoLabel: 'Remote group',
        worktreeLabel: 'Remote folder'
      })
    }
  )

  // A repo id is registered per host, so two hosts can hold one id at different
  // paths. Their worktree ids are then unique, so the collision lives entirely in
  // the repo lookup — the id-keyed repo map is last-wins and names the wrong project.
  function duplicateRepoIdAcrossHosts(): Repo[] {
    return [
      {
        id: 'dup',
        displayName: 'Dup Local',
        path: '/laptop/dup',
        connectionId: null,
        badgeColor: 'blue',
        addedAt: 0
      },
      {
        id: 'dup',
        displayName: 'Dup Remote',
        path: '/remote/dup',
        connectionId: 'ssh-1',
        badgeColor: 'blue',
        addedAt: 0
      }
    ]
  }

  it('names the local project for a unique worktree id whose repo id spans hosts', () => {
    const state = {
      ...useAppStore.getInitialState(),
      // The ssh row is last, so a bare-id repo lookup answers "Dup Remote" here.
      repos: duplicateRepoIdAcrossHosts(),
      worktreesByRepo: {
        dup: [
          makeWorktree({
            id: 'dup::/laptop/dup',
            repoId: 'dup',
            hostId: 'local',
            path: '/laptop/dup',
            displayName: 'Laptop main'
          })
        ]
      }
    }
    expect(getNotificationWorkspaceLabels(state, 'dup::/laptop/dup', 'Terminal')).toEqual({
      repoLabel: 'Dup Local',
      worktreeLabel: 'Laptop main'
    })
  })

  it('omits the project rather than guessing when a spanning repo id has no provable host', () => {
    const state = {
      ...useAppStore.getInitialState(),
      repos: duplicateRepoIdAcrossHosts(),
      worktreesByRepo: {
        dup: [
          makeWorktree({
            id: 'dup::/laptop/dup',
            repoId: 'dup',
            path: '/laptop/dup',
            displayName: 'Laptop main'
          })
        ]
      }
    }
    // Last-wins on the bare id would answer "Dup Remote" for this local row.
    expect(getNotificationWorkspaceLabels(state, 'dup::/laptop/dup', 'Terminal')).toEqual({
      repoLabel: undefined,
      worktreeLabel: 'Laptop main'
    })
  })

  it('does not pick an arbitrary folder when hosts have conflicting records', () => {
    const state = stateWithWorkspace()
    state.folderWorkspaces = (['ssh:a', 'ssh:b'] as const).map((executionHostId) =>
      makeFolderWorkspace({ id: 'duplicate', name: executionHostId, executionHostId })
    )
    expect(getNotificationWorkspaceLabels(state, 'folder:duplicate', 'Terminal')).toEqual({
      repoLabel: undefined,
      worktreeLabel: 'Terminal'
    })
  })

  describe('STA-4343 two-host worktree id collision', () => {
    const COLLIDING_ID = 'repo1::/work/orca'
    const HOSTS = {
      // The laptop row is unqualified, which is how a local worktree listing publishes it.
      local: {
        row: { displayName: 'Laptop feature' },
        repo: { displayName: 'Orca on laptop', connectionId: null }
      },
      'ssh:build-box': {
        row: { hostId: 'ssh:build-box' as const, displayName: 'Build box feature' },
        repo: { displayName: 'Orca on build box', connectionId: 'build-box' }
      }
    } as const
    type CollidingHostId = keyof typeof HOSTS

    /**
     * Reachability: both rows land through the production per-host merge, which
     * replaces only the refreshing host's rows and keeps every other host's.
     *
     * `naiveWinner` refreshes first and is listed last in `repos`, so it is the row
     * a first-wins worktree map AND a last-wins repo map both answer with. Naming
     * the other host therefore cannot pass by accident.
     */
    function stateWithCollidingHosts(naiveWinner: CollidingHostId) {
      const rival: CollidingHostId = naiveWinner === 'local' ? 'ssh:build-box' : 'local'
      const repos: Repo[] = [rival, naiveWinner].map((hostId) => ({
        id: 'repo1',
        path: '/work/orca',
        badgeColor: 'blue',
        addedAt: 0,
        ...HOSTS[hostId].repo
      }))
      const merged = [naiveWinner, rival].reduce<Worktree[] | undefined>(
        (current, hostId) =>
          mergeWorktreesForHost(
            current,
            [
              makeWorktree({
                id: COLLIDING_ID,
                repoId: 'repo1',
                path: '/work/orca',
                ...HOSTS[hostId].row
              })
            ],
            hostId,
            worktreeHostMatchOptions({ repos }, 'repo1', hostId)
          ),
        undefined
      )
      expect(merged).toHaveLength(2)
      return { ...stateWithWorkspace(), repos, worktreesByRepo: { repo1: merged ?? [] } }
    }

    it.each(['local', 'ssh:build-box'] as const)(
      'names the %s row, never the other host',
      (hostId) => {
        const state = stateWithCollidingHosts(hostId === 'local' ? 'ssh:build-box' : 'local')
        state.activeWorktreeId = COLLIDING_ID
        state.activeWorkspaceExecutionHostId = hostId
        expect(getNotificationWorkspaceLabels(state, COLLIDING_ID, 'Terminal')).toEqual({
          repoLabel: HOSTS[hostId].repo.displayName,
          worktreeLabel: HOSTS[hostId].row.displayName
        })
      }
    )

    it.each(['local', 'ssh:build-box'] as const)(
      'uses provenance only from the owning %s row',
      (hostId) => {
        const state = stateWithCollidingHosts(hostId === 'local' ? 'ssh:build-box' : 'local')
        state.worktreesByRepo.repo1 = state.worktreesByRepo.repo1.map((row) => ({
          ...row,
          ...(row.hostId === 'ssh:build-box'
            ? { cliProvenance: { kind: 'created-by-cli' as const, createdAt: 1 } }
            : {})
        }))
        state.activeWorktreeId = COLLIDING_ID
        state.activeWorkspaceExecutionHostId = hostId
        expect(getNotificationWorkspaceLabels(state, COLLIDING_ID).workspaceOrigin).toBe(
          hostId === 'ssh:build-box' ? 'cli' : undefined
        )
      }
    )

    it.each(['local', 'ssh:build-box'] as const)(
      'omits both names for a background workspace whose %s row would win a bare-id lookup',
      (naiveWinner) => {
        const state = stateWithCollidingHosts(naiveWinner)
        state.activeWorktreeId = 'repo1::/work/other'
        state.activeWorkspaceExecutionHostId = 'local'
        expect(getNotificationWorkspaceLabels(state, COLLIDING_ID, 'Terminal')).toEqual({
          repoLabel: undefined,
          worktreeLabel: 'Terminal'
        })
      }
    )
  })

  it.each(['folder:missing', 'missing-worktree', FLOATING_TERMINAL_WORKTREE_ID])(
    'uses readable fallbacks for %s',
    (id) => {
      const state = stateWithWorkspace()
      expect(getNotificationWorkspaceLabels(state, id, 'My terminal')).toEqual({
        repoLabel: undefined,
        worktreeLabel: 'My terminal'
      })
      expect(getNotificationWorkspaceLabels(state, id, '  ')).toEqual({
        repoLabel: undefined,
        worktreeLabel: 'workspace'
      })
    }
  )
})
