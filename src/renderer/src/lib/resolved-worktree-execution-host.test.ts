import { describe, expect, it } from 'vitest'
import { getResolvedExecutionHostIdForWorktree } from './resolved-worktree-execution-host'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner'

describe('getResolvedExecutionHostIdForWorktree', () => {
  it('keeps missing workspace ownership unresolved', () => {
    expect(getResolvedExecutionHostIdForWorktree({}, null)).toBeNull()
    expect(getResolvedExecutionHostIdForWorktree({}, undefined)).toBeNull()
  })

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
})
