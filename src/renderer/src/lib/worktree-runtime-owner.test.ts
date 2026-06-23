import { describe, expect, it } from 'vitest'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree,
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

  it('routes folder workspaces to their project group runtime owner', () => {
    expect(getSettingsForWorktreeRuntimeOwner(state, 'folder:runtime-folder')).toEqual({
      activeRuntimeEnvironmentId: 'folder-env'
    })
    expect(getExecutionHostIdForWorktree(state, 'folder:runtime-folder')).toBe('runtime:folder-env')
  })

  it('keeps explicit-local folder workspaces local even while a runtime is focused', () => {
    expect(getSettingsForWorktreeRuntimeOwner(state, 'folder:local-folder')).toEqual({
      activeRuntimeEnvironmentId: null
    })
    expect(getExecutionHostIdForWorktree(state, 'folder:local-folder')).toBe('local')
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
