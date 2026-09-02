import { describe, expect, it } from 'vitest'
import {
  assertWorktreeOperationGenerationSnapshotCurrent,
  captureWorktreeOperationGenerationSnapshot
} from './worktree-operation-generation'
import {
  resolveWorktreeOperationRoute,
  type WorktreeOperationRoute
} from './worktree-operation-route'

const WORKTREE_ID = 'repo::/worktree'
const LOCAL_ROUTE: WorktreeOperationRoute = {
  executionHostId: 'local',
  runtimeEnvironmentId: null
}

describe('worktree operation generation', () => {
  it('treats an explicit null current route as stale instead of falling back', () => {
    const state = {
      repos: [{ id: 'repo', connectionId: null, executionHostId: 'local' as const }],
      worktreesByRepo: {
        repo: [{ id: WORKTREE_ID, repoId: 'repo', hostId: 'local' as const }]
      }
    }
    expect(resolveWorktreeOperationRoute(state, WORKTREE_ID)).toEqual(LOCAL_ROUTE)

    expect(() =>
      assertWorktreeOperationGenerationSnapshotCurrent(
        () => state,
        WORKTREE_ID,
        captureWorktreeOperationGenerationSnapshot(LOCAL_ROUTE),
        () => new Error('owner changed'),
        () => null
      )
    ).toThrow('owner changed')
  })

  it('uses the default route resolver when no provenance resolver is provided', () => {
    const state = {
      repos: [{ id: 'repo', connectionId: null, executionHostId: 'local' as const }],
      worktreesByRepo: {
        repo: [{ id: WORKTREE_ID, repoId: 'repo', hostId: 'local' as const }]
      }
    }

    expect(
      assertWorktreeOperationGenerationSnapshotCurrent(
        () => state,
        WORKTREE_ID,
        captureWorktreeOperationGenerationSnapshot(LOCAL_ROUTE),
        () => new Error('owner changed')
      )
    ).toEqual(LOCAL_ROUTE)
  })
})
