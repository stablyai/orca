import { describe, expect, it } from 'vitest'
import '../../../shared/constants'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from './worktree-runtime-owner'
import './terminal-worktree-route'
import './runtime-session-mirror-owners'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

/** The owner's paired server, as production callers read it; null for this app or a twin. */

describe('runtime owner identity indexes', () => {
  it('rebuilds owner indexes when immutable collection references change', () => {
    const first: WorktreeRuntimeOwnerState = {
      repos: [{ id: 'repo', connectionId: null, executionHostId: 'runtime:repo-one' }],
      worktreesByRepo: { repo: [{ id: 'worktree', repoId: 'repo' }] },
      folderWorkspaces: [{ id: 'folder', projectGroupId: 'group' }],
      projectGroups: [{ id: 'group', connectionId: null, executionHostId: 'runtime:folder-one' }]
    }
    expect(runtimeEnvironmentIdOrLocalUnlessTwin(first, 'worktree')).toBe('repo-one')
    expect(runtimeEnvironmentIdOrLocalUnlessTwin(first, 'folder:folder')).toBe('folder-one')

    const second: WorktreeRuntimeOwnerState = {
      repos: [{ id: 'repo', connectionId: null, executionHostId: 'runtime:repo-two' }],
      worktreesByRepo: {
        repo: [{ id: 'worktree', repoId: 'repo', hostId: 'runtime:worktree-two' }]
      },
      folderWorkspaces: [{ id: 'folder', projectGroupId: 'group' }],
      projectGroups: [{ id: 'group', connectionId: null, executionHostId: 'runtime:folder-two' }]
    }
    expect(runtimeEnvironmentIdOrLocalUnlessTwin(second, 'worktree')).toBe('worktree-two')
    expect(runtimeEnvironmentIdOrLocalUnlessTwin(second, 'folder:folder')).toBe('folder-two')
  })
})
