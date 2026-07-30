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

  it('attributes an unowned repo to the active runtime, not the client machine', () => {
    // Why: a repo on a remote `orca serve` machine has no connectionId, because it
    // is local to that server. Resolving it to LOCAL sends the operation to this
    // client's daemon, which cannot see the path (#9047).
    const serveHostedState: WorktreeRuntimeOwnerState = {
      repos: [{ id: 'served-repo', connectionId: null, executionHostId: null }],
      worktreesByRepo: {
        'served-repo': [{ id: 'served-repo::wt-a', repoId: 'served-repo' }]
      },
      settings: { activeRuntimeEnvironmentId: 'env-1' }
    }
    expect(getResolvedExecutionHostIdForWorktree(serveHostedState, 'served-repo::wt-a')).toBe(
      'runtime:env-1'
    )
  })

  it('attributes an unowned folder workspace to the active runtime', () => {
    const serveHostedFolder: WorktreeRuntimeOwnerState = {
      folderWorkspaces: [{ id: 'folder-1', projectGroupId: 'group-1', connectionId: null }],
      projectGroups: [{ id: 'group-1', connectionId: null, executionHostId: null }],
      settings: { activeRuntimeEnvironmentId: 'env-1' }
    }
    expect(getResolvedExecutionHostIdForWorktree(serveHostedFolder, 'folder:folder-1')).toBe(
      'runtime:env-1'
    )
  })

  it('still resolves unowned workspaces to local when no runtime is active', () => {
    expect(
      getResolvedExecutionHostIdForWorktree(
        {
          repos: [{ id: 'local-repo', connectionId: null, executionHostId: null }],
          worktreesByRepo: {
            'local-repo': [{ id: 'local-repo::wt-a', repoId: 'local-repo' }]
          }
        },
        'local-repo::wt-a'
      )
    ).toBe('local')
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
