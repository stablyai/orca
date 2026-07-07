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
