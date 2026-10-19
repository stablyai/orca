import { describe, expect, it } from 'vitest'
import { resolveNotebookExecutionHost } from './ipynb-execution-host'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'

const WORKTREE_ID = 'repo-1::/srv/w'

function rows(
  repo: Record<string, string>,
  worktree: {
    hostId?: `runtime:${string}` | `ssh:${string}` | 'local'
    runtimeOwnerEnvironmentId?: string
  }
): WorktreeOperationRouteState {
  return {
    repos: [{ id: 'repo-1', ...repo }],
    worktreesByRepo: { 'repo-1': [{ id: WORKTREE_ID, repoId: 'repo-1', ...worktree }] }
  }
}

describe('resolveNotebookExecutionHost', () => {
  it.each([
    ['a local workspace', rows({}, { hostId: 'local' }), 'local'],
    ['a legacy unstamped local workspace', rows({}, {}), 'local'],
    ['a direct SSH workspace', rows({ connectionId: 'box' }, { hostId: 'ssh:box' }), 'remote'],
    [
      'a managed SSH workspace, which has no connection id',
      rows(
        { executionHostId: 'runtime:env-orcad' },
        { hostId: 'runtime:env-orcad', runtimeOwnerEnvironmentId: 'env-orcad' }
      ),
      'remote'
    ],
    ['unloaded rows', {}, 'unresolved']
  ] as const)('reads %s as %s', (_name, state, expected) => {
    expect(resolveNotebookExecutionHost(state, WORKTREE_ID)).toBe(expected)
  })

  it('treats a local folder workspace as local and a server-owned one as remote', () => {
    const folder = (
      executionHostId: 'local' | `runtime:${string}`
    ): WorktreeOperationRouteState => ({
      folderWorkspaces: [
        { id: 'f1', projectGroupId: 'g1', connectionId: null, executionHostId, diffComments: [] }
      ]
    })
    expect(resolveNotebookExecutionHost(folder('local'), 'folder:f1')).toBe('local')
    expect(resolveNotebookExecutionHost(folder('runtime:env-a'), 'folder:f1')).toBe('remote')
  })
})
