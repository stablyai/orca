import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../../shared/worktree/types'
import { resolveWorktreeOperationRouteResult } from './worktree-operation-route'

const WORKTREE_ID = 'repo-1::/srv/worktree'

function worktree(hostId: Worktree['hostId'], runtimeOwnerEnvironmentId?: string): Worktree {
  return {
    id: WORKTREE_ID,
    repoId: 'repo-1',
    path: '/srv/worktree',
    hostId,
    runtimeOwnerEnvironmentId
  } as Worktree
}

describe('resolveWorktreeOperationRouteResult', () => {
  it('fails ownerless rows closed mid-hydration while a saved runtime could own them', () => {
    // No repo/active-runtime evidence can decide first: only the unhydrated saved-runtime catalog fails this closed. Marking it hydrated routes local via the detected row; adding other evidence would leave this branch uncovered.
    expect(
      resolveWorktreeOperationRouteResult(
        {
          runtimeEnvironments: [{ id: 'hub-a' }, { id: 'hub-b' }],
          runtimeEnvironmentCatalogHydrated: false,
          worktreesByRepo: { 'repo-1': [worktree(undefined)] },
          detectedWorktreesByRepo: {
            'repo-1': { worktrees: [worktree(undefined)] }
          }
        },
        WORKTREE_ID
      )
    ).toEqual({ kind: 'missing' })
  })
})
