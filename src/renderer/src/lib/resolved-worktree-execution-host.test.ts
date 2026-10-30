import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  getActiveWorkspaceOwnerTarget,
  getResolvedExecutionHostIdForWorktree
} from './resolved-worktree-execution-host'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

describe('getResolvedExecutionHostIdForWorktree', () => {
  it('requires a hydrated worktree before treating a matching local repo row as authoritative', () => {
    expect(
      getResolvedExecutionHostIdForWorktree(
        { repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'local' }] },
        'repo-1::/remote/worktree'
      )
    ).toBeNull()
  })

  it('resolves hydrated local and remote owners without using a focused-host fallback', () => {
    const localState: WorktreeRuntimeOwnerState = {
      repos: [{ id: 'local-repo', connectionId: null, executionHostId: 'local' }],
      worktreesByRepo: {
        'local-repo': [{ id: 'local-repo::wt-a', repoId: 'local-repo' }]
      }
    }
    expect(getResolvedExecutionHostIdForWorktree(localState, 'local-repo::wt-a')).toBe('local')

    const remoteState: WorktreeRuntimeOwnerState = {
      repos: [{ id: 'same-repo', connectionId: null, executionHostId: 'local' }],
      worktreesByRepo: {
        'same-repo': [
          {
            id: 'same-repo::/remote/worktree',
            repoId: 'same-repo',
            hostId: 'ssh:target-1'
          }
        ]
      }
    }
    expect(getResolvedExecutionHostIdForWorktree(remoteState, 'same-repo::/remote/worktree')).toBe(
      'ssh:target-1'
    )
  })

  it('keeps missing folder catalogs unresolved but honors restored runtime ownership', () => {
    expect(getResolvedExecutionHostIdForWorktree({}, 'folder:missing')).toBeNull()
    expect(
      getResolvedExecutionHostIdForWorktree(
        {
          restoredRuntimeHostIdByWorkspaceSessionKey: {
            'folder:restored': 'runtime:runtime-1'
          }
        },
        'folder:restored'
      )
    ).toBe('runtime:runtime-1')
  })

  it('uses the folder host stamp when same-ID project groups exist on different hosts', () => {
    expect(
      getResolvedExecutionHostIdForWorktree(
        {
          folderWorkspaces: [
            {
              id: 'same-folder',
              projectGroupId: 'same-group',
              executionHostId: 'runtime:runtime-1'
            }
          ],
          projectGroups: [
            { id: 'same-group', executionHostId: 'local' },
            { id: 'same-group', executionHostId: 'runtime:runtime-1' }
          ]
        },
        'folder:same-folder'
      )
    ).toBe('runtime:runtime-1')
  })
})

function stateFocusing(
  repo: { executionHostId: ExecutionHostId; connectionId?: string },
  worktreeHostId?: ExecutionHostId
): WorktreeRuntimeOwnerState {
  return {
    // The default host must never leak into the owner answer.
    settings: { activeRuntimeEnvironmentId: 'env-default' },
    repos: [{ id: 'repo-1', ...repo }],
    worktreesByRepo: {
      'repo-1': [{ id: 'repo-1::/w', repoId: 'repo-1', hostId: worktreeHostId }]
    },
    activeWorktreeId: 'repo-1::/w'
  }
}

describe('getActiveWorkspaceOwnerTarget', () => {
  it('skips owner resolution once the catalog has hydrated with no paired server', () => {
    const state = {
      ...stateFocusing({ executionHostId: 'runtime:env-b' }),
      runtimeEnvironments: [],
      runtimeEnvironmentCatalogHydrated: true
    }
    expect(getActiveWorkspaceOwnerTarget(state)).toBeNull()
    expect(
      getActiveWorkspaceOwnerTarget({ ...state, runtimeEnvironmentCatalogHydrated: false })
    ).toEqual({ kind: 'environment', environmentId: 'env-b' })
  })
})
