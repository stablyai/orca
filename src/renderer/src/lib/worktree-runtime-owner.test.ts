import { describe, expect, it } from 'vitest'
import {
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
  }
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
})
