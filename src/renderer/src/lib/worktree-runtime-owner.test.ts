import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree,
  getRuntimeSessionMirrorEnvironmentIds,
  getSettingsForWorktreeRuntimeOwner,
  type WorktreeRuntimeOwnerState
} from './worktree-runtime-owner'

const state: WorktreeRuntimeOwnerState = {
  settings: { activeRuntimeEnvironmentId: 'focused-env' },
  repos: [
    { id: 'local-repo', connectionId: null, executionHostId: 'local' },
    { id: 'legacy-repo', connectionId: null, executionHostId: null },
    { id: 'runtime-repo', connectionId: null, executionHostId: 'runtime:owner-env' }
  ],
  worktreesByRepo: {
    'local-repo': [{ id: 'local-repo::wt-a', repoId: 'local-repo' }],
    'legacy-repo': [{ id: 'legacy-repo::wt-legacy', repoId: 'legacy-repo' }],
    'runtime-repo': [{ id: 'runtime-repo::wt-b', repoId: 'runtime-repo' }]
  },
  projectGroups: [
    { id: 'local-group', connectionId: null, executionHostId: 'local' },
    {
      id: 'runtime-group',
      connectionId: 'ssh-inside-runtime',
      executionHostId: 'runtime:folder-env'
    }
  ],
  folderWorkspaces: [
    { id: 'local-folder', projectGroupId: 'local-group' },
    { id: 'runtime-folder', projectGroupId: 'runtime-group' }
  ]
}

describe('getSettingsForWorktreeRuntimeOwner', () => {
  it('routes to the runtime owner of the worktree', () => {
    expect(getSettingsForWorktreeRuntimeOwner(state, 'runtime-repo::wt-b')).toEqual({
      activeRuntimeEnvironmentId: 'owner-env'
    })
  })

  it('keeps explicit-local worktrees local even while a runtime is focused', () => {
    expect(getSettingsForWorktreeRuntimeOwner(state, 'local-repo::wt-a')).toEqual({
      activeRuntimeEnvironmentId: null
    })
  })

  it('keeps the synthetic floating workspace local while a runtime is focused', () => {
    expect(getSettingsForWorktreeRuntimeOwner(state, FLOATING_TERMINAL_WORKTREE_ID)).toEqual({
      activeRuntimeEnvironmentId: null
    })
    expect(getExecutionHostIdForWorktree(state, FLOATING_TERMINAL_WORKTREE_ID)).toBe('local')
  })

  it('routes folder workspaces to their project group runtime owner', () => {
    expect(getSettingsForWorktreeRuntimeOwner(state, 'folder:runtime-folder')).toEqual({
      activeRuntimeEnvironmentId: 'folder-env'
    })
    expect(getExecutionHostIdForWorktree(state, 'folder:runtime-folder')).toBe('runtime:folder-env')
  })

  it('routes restored runtime folder workspaces before their catalog loads', () => {
    const restoredFolderState: WorktreeRuntimeOwnerState = {
      settings: { activeRuntimeEnvironmentId: 'focused-env' },
      folderWorkspaces: [],
      projectGroups: [],
      restoredRuntimeHostIdByWorkspaceSessionKey: {
        'folder:restored-folder': 'runtime:restored-env'
      }
    }

    expect(
      getSettingsForWorktreeRuntimeOwner(restoredFolderState, 'folder:restored-folder')
    ).toEqual({
      activeRuntimeEnvironmentId: 'restored-env'
    })
    expect(getRuntimeEnvironmentIdForWorktree(restoredFolderState, 'folder:restored-folder')).toBe(
      'restored-env'
    )
    expect(
      getExplicitRuntimeEnvironmentIdForWorktree(restoredFolderState, 'folder:restored-folder')
    ).toBe('restored-env')
    expect(getExecutionHostIdForWorktree(restoredFolderState, 'folder:restored-folder')).toBe(
      'runtime:restored-env'
    )
  })

  it('keeps explicit-local folder workspaces local even while a runtime is focused', () => {
    expect(getSettingsForWorktreeRuntimeOwner(state, 'folder:local-folder')).toEqual({
      activeRuntimeEnvironmentId: null
    })
    expect(getExecutionHostIdForWorktree(state, 'folder:local-folder')).toBe('local')

    const restoredOwnerState: WorktreeRuntimeOwnerState = {
      ...state,
      restoredRuntimeHostIdByWorkspaceSessionKey: {
        'folder:local-folder': 'runtime:stale-env'
      }
    }
    expect(getRuntimeEnvironmentIdForWorktree(restoredOwnerState, 'folder:local-folder')).toBeNull()
    expect(getExecutionHostIdForWorktree(restoredOwnerState, 'folder:local-folder')).toBe('local')
  })

  it('keeps folder workspaces with their own SSH target off the focused runtime', () => {
    const folderConnectionState: WorktreeRuntimeOwnerState = {
      ...state,
      projectGroups: [{ id: 'folder-group', connectionId: null, executionHostId: null }],
      folderWorkspaces: [
        { id: 'folder-ssh', projectGroupId: 'folder-group', connectionId: 'folder-remote' }
      ]
    }

    expect(getSettingsForWorktreeRuntimeOwner(folderConnectionState, 'folder:folder-ssh')).toEqual({
      activeRuntimeEnvironmentId: null
    })
    expect(getExecutionHostIdForWorktree(folderConnectionState, 'folder:folder-ssh')).toBe(
      'ssh:folder-remote'
    )
  })

  it('prefers project group runtime ownership over stale folder SSH targets', () => {
    const staleFolderConnectionState: WorktreeRuntimeOwnerState = {
      ...state,
      folderWorkspaces: [
        { id: 'runtime-folder', projectGroupId: 'runtime-group', connectionId: 'old-ssh' }
      ]
    }

    expect(
      getSettingsForWorktreeRuntimeOwner(staleFolderConnectionState, 'folder:runtime-folder')
    ).toEqual({
      activeRuntimeEnvironmentId: 'folder-env'
    })
    expect(getExecutionHostIdForWorktree(staleFolderConnectionState, 'folder:runtime-folder')).toBe(
      'runtime:folder-env'
    )
  })
})

describe('getExplicitRuntimeEnvironmentIdForWorktree', () => {
  it('does not treat the focused runtime as ownership for legacy-local worktrees', () => {
    expect(getRuntimeEnvironmentIdForWorktree(state, 'legacy-repo::wt-legacy')).toBe('focused-env')
    expect(getExplicitRuntimeEnvironmentIdForWorktree(state, 'legacy-repo::wt-legacy')).toBeNull()
  })

  it('returns the runtime owner when the repo or folder explicitly names one', () => {
    expect(getExplicitRuntimeEnvironmentIdForWorktree(state, 'runtime-repo::wt-b')).toBe(
      'owner-env'
    )
    expect(getExplicitRuntimeEnvironmentIdForWorktree(state, 'folder:runtime-folder')).toBe(
      'folder-env'
    )
  })

  it('uses a worktree host id before the repo owner', () => {
    const hostOverrideState: WorktreeRuntimeOwnerState = {
      ...state,
      worktreesByRepo: {
        ...state.worktreesByRepo,
        'runtime-repo': [
          { id: 'runtime-repo::wt-local-override', repoId: 'runtime-repo', hostId: 'local' },
          {
            id: 'runtime-repo::wt-runtime-override',
            repoId: 'runtime-repo',
            hostId: 'runtime:worktree-env'
          }
        ]
      }
    }

    expect(
      getExplicitRuntimeEnvironmentIdForWorktree(
        hostOverrideState,
        'runtime-repo::wt-local-override'
      )
    ).toBeNull()
    expect(
      getRuntimeEnvironmentIdForWorktree(hostOverrideState, 'runtime-repo::wt-local-override')
    ).toBeNull()
    expect(
      getExecutionHostIdForWorktree(hostOverrideState, 'runtime-repo::wt-local-override')
    ).toBe('local')
    expect(
      getExplicitRuntimeEnvironmentIdForWorktree(
        hostOverrideState,
        'runtime-repo::wt-runtime-override'
      )
    ).toBe('worktree-env')
    expect(
      getRuntimeEnvironmentIdForWorktree(hostOverrideState, 'runtime-repo::wt-runtime-override')
    ).toBe('worktree-env')
    expect(
      getExecutionHostIdForWorktree(hostOverrideState, 'runtime-repo::wt-runtime-override')
    ).toBe('runtime:worktree-env')
  })
})

describe('runtime owner identity indexes', () => {
  it('indexes immutable owner records once across repeated worktree and folder lookups', () => {
    let worktreeIdReads = 0
    let repoIdReads = 0
    let folderWorkspaceIdReads = 0
    let projectGroupIdReads = 0
    const targetWorktreeId = 'worktree-99-99'
    const targetRepoId = 'repo-99'
    const targetFolderWorkspaceId = 'folder-workspace-999'
    const targetProjectGroupId = 'project-group-999'
    const repos: NonNullable<WorktreeRuntimeOwnerState['repos']>[number][] = []
    const worktreesByRepo: NonNullable<WorktreeRuntimeOwnerState['worktreesByRepo']> = {}
    const folderWorkspaces: NonNullable<WorktreeRuntimeOwnerState['folderWorkspaces']>[number][] =
      []
    const projectGroups: NonNullable<WorktreeRuntimeOwnerState['projectGroups']>[number][] = []

    for (let repoIndex = 0; repoIndex < 100; repoIndex += 1) {
      const repoId = `repo-${repoIndex}`
      const repo: NonNullable<WorktreeRuntimeOwnerState['repos']>[number] = {
        id: repoId,
        connectionId: null,
        executionHostId: repoId === targetRepoId ? 'runtime:repo-owner' : 'local'
      }
      Object.defineProperty(repo, 'id', {
        enumerable: true,
        get: () => {
          repoIdReads += 1
          return repoId
        }
      })
      repos.push(repo)
      worktreesByRepo[repoId] = Array.from({ length: 100 }, (_, worktreeIndex) => {
        const worktreeId = `worktree-${repoIndex}-${worktreeIndex}`
        const worktree = { id: worktreeId, repoId }
        Object.defineProperty(worktree, 'id', {
          enumerable: true,
          get: () => {
            worktreeIdReads += 1
            return worktreeId
          }
        })
        return worktree
      })
    }
    for (let index = 0; index < 1_000; index += 1) {
      const folderWorkspaceId = `folder-workspace-${index}`
      const projectGroupId = `project-group-${index}`
      const folderWorkspace = { id: folderWorkspaceId, projectGroupId }
      const projectGroup: NonNullable<WorktreeRuntimeOwnerState['projectGroups']>[number] = {
        id: projectGroupId,
        connectionId: null,
        executionHostId: projectGroupId === targetProjectGroupId ? 'runtime:folder-owner' : 'local'
      }
      Object.defineProperty(folderWorkspace, 'id', {
        enumerable: true,
        get: () => {
          folderWorkspaceIdReads += 1
          return folderWorkspaceId
        }
      })
      Object.defineProperty(projectGroup, 'id', {
        enumerable: true,
        get: () => {
          projectGroupIdReads += 1
          return projectGroupId
        }
      })
      folderWorkspaces.push(folderWorkspace)
      projectGroups.push(projectGroup)
    }
    const indexedState: WorktreeRuntimeOwnerState = {
      settings: { activeRuntimeEnvironmentId: null },
      repos,
      worktreesByRepo,
      folderWorkspaces,
      projectGroups
    }

    for (let lookup = 0; lookup < 200; lookup += 1) {
      getRuntimeEnvironmentIdForWorktree(indexedState, targetWorktreeId)
      getExplicitRuntimeEnvironmentIdForWorktree(indexedState, targetWorktreeId)
      getExecutionHostIdForWorktree(indexedState, targetWorktreeId)
      getRuntimeEnvironmentIdForWorktree(indexedState, `folder:${targetFolderWorkspaceId}`)
      getExplicitRuntimeEnvironmentIdForWorktree(indexedState, `folder:${targetFolderWorkspaceId}`)
      getExecutionHostIdForWorktree(indexedState, `folder:${targetFolderWorkspaceId}`)
    }

    expect(worktreeIdReads).toBe(10_000)
    expect(repoIdReads).toBe(100)
    expect(folderWorkspaceIdReads).toBe(1_000)
    expect(projectGroupIdReads).toBe(1_000)
    expect(getRuntimeEnvironmentIdForWorktree(indexedState, targetWorktreeId)).toBe('repo-owner')
    expect(getExecutionHostIdForWorktree(indexedState, `folder:${targetFolderWorkspaceId}`)).toBe(
      'runtime:folder-owner'
    )
  })

  it('rebuilds owner indexes when immutable collection references change', () => {
    const first: WorktreeRuntimeOwnerState = {
      repos: [{ id: 'repo', connectionId: null, executionHostId: 'runtime:repo-one' }],
      worktreesByRepo: { repo: [{ id: 'worktree', repoId: 'repo' }] },
      folderWorkspaces: [{ id: 'folder', projectGroupId: 'group' }],
      projectGroups: [{ id: 'group', connectionId: null, executionHostId: 'runtime:folder-one' }]
    }
    expect(getRuntimeEnvironmentIdForWorktree(first, 'worktree')).toBe('repo-one')
    expect(getRuntimeEnvironmentIdForWorktree(first, 'folder:folder')).toBe('folder-one')

    const second: WorktreeRuntimeOwnerState = {
      repos: [{ id: 'repo', connectionId: null, executionHostId: 'runtime:repo-two' }],
      worktreesByRepo: {
        repo: [{ id: 'worktree', repoId: 'repo', hostId: 'runtime:worktree-two' }]
      },
      folderWorkspaces: [{ id: 'folder', projectGroupId: 'group' }],
      projectGroups: [{ id: 'group', connectionId: null, executionHostId: 'runtime:folder-two' }]
    }
    expect(getRuntimeEnvironmentIdForWorktree(second, 'worktree')).toBe('worktree-two')
    expect(getRuntimeEnvironmentIdForWorktree(second, 'folder:folder')).toBe('folder-two')
  })
})

describe('getRuntimeSessionMirrorEnvironmentIds', () => {
  it('includes focused runtime plus explicit repo, worktree, and folder owners', () => {
    const multiRuntimeState: WorktreeRuntimeOwnerState = {
      ...state,
      worktreesByRepo: {
        ...state.worktreesByRepo,
        'runtime-repo': [
          ...(state.worktreesByRepo?.['runtime-repo'] ?? []),
          {
            id: 'runtime-repo::wt-runtime-override',
            repoId: 'runtime-repo',
            hostId: 'runtime:worktree-env'
          }
        ]
      }
    }

    expect(getRuntimeSessionMirrorEnvironmentIds(multiRuntimeState)).toEqual([
      'focused-env',
      'folder-env',
      'owner-env',
      'worktree-env'
    ])
  })

  it('includes restored runtime folder owners before their catalog loads', () => {
    expect(
      getRuntimeSessionMirrorEnvironmentIds({
        settings: { activeRuntimeEnvironmentId: 'focused-env' },
        restoredRuntimeHostIdByWorkspaceSessionKey: {
          'folder:restored-folder': 'runtime:restored-env'
        }
      })
    ).toEqual(['focused-env', 'restored-env'])
  })

  it('does not include local or SSH owners', () => {
    const localOnlyState: WorktreeRuntimeOwnerState = {
      settings: { activeRuntimeEnvironmentId: null },
      repos: [
        { id: 'local-repo', connectionId: null, executionHostId: 'local' },
        { id: 'ssh-repo', connectionId: 'remote', executionHostId: 'ssh:remote' }
      ],
      worktreesByRepo: {
        'local-repo': [{ id: 'local-repo::wt-local', repoId: 'local-repo', hostId: 'local' }],
        'ssh-repo': [{ id: 'ssh-repo::wt-ssh', repoId: 'ssh-repo', hostId: 'ssh:remote' }]
      }
    }

    expect(getRuntimeSessionMirrorEnvironmentIds(localOnlyState)).toEqual([])
  })
})
