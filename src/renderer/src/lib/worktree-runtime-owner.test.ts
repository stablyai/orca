import { describe, expect, it } from 'vitest'
import {
  getExecutionHostIdForWorktree,
  getSettingsForWorktreeRuntimeOwner,
  type WorktreeRuntimeOwnerState
} from './worktree-runtime-owner'

const state: WorktreeRuntimeOwnerState = {
  settings: { activeRuntimeEnvironmentId: 'focused-env' },
  repos: [
    { id: 'local-repo', connectionId: null, executionHostId: 'local' },
    { id: 'runtime-repo', connectionId: null, executionHostId: 'runtime:owner-env' }
  ],
  worktreesByRepo: {
    'local-repo': [{ id: 'local-repo::wt-a', repoId: 'local-repo' }],
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
