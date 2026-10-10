import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceCleanupRemoveResult } from '@/store/slices/workspace-cleanup'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))
const commits = new Map<string, ReturnType<typeof vi.fn>>()
vi.mock('../sidebar/active-worktree-focus-after-delete', () => ({
  prepareActiveWorktreeFocusAfterDelete: (worktreeId: string) => {
    const commit = vi.fn()
    commits.set(worktreeId, commit)
    return commit
  }
}))

import { startWorkspaceCleanupBackgroundRemoval } from './workspace-cleanup-background-removal'
import { withWorkspaceCleanupFocusAfterDelete } from './workspace-cleanup-focus-after-delete'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

function candidate(name: string) {
  return makeCandidate({
    worktreeId: `repo-1::/repo/${name}`,
    displayName: name,
    branch: name,
    path: `/repo/${name}`
  })
}

describe('workspace cleanup focus hand-off per removed row', () => {
  beforeEach(() => {
    commits.clear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('hands off when a timed-out row is removed after the batch has settled', async () => {
    const active = candidate('active')
    let resolveRemoval: (result: WorkspaceCleanupRemoveResult) => void = () => {}
    const removeCandidates = vi.fn(
      () =>
        new Promise<WorkspaceCleanupRemoveResult>((resolve) => {
          resolveRemoval = resolve
        })
    )
    const onResult = vi.fn()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [active],
      removeCandidates: withWorkspaceCleanupFocusAfterDelete(removeCandidates, [active]),
      onProgress: vi.fn(),
      onResult,
      removalTimeoutMs: 5,
      removalSettlementGraceMs: 5
    })
    await vi.advanceTimersByTimeAsync(20)
    expect(onResult).toHaveBeenCalled()
    expect(commits.get(active.worktreeId)).not.toHaveBeenCalled()

    resolveRemoval({
      removedIds: [active.worktreeId],
      removedIdentities: [getWorkspaceCleanupCandidateIdentity(active)],
      failures: []
    })
    await flush()
    expect(commits.get(active.worktreeId)).toHaveBeenCalledTimes(1)
  })

  it('never hands off for a failed row and still reports a removed row when its hand-off throws', async () => {
    const failed = candidate('failed')
    const removed = candidate('removed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const remove = withWorkspaceCleanupFocusAfterDelete(
      vi
        .fn()
        .mockResolvedValueOnce({
          removedIds: [],
          removedIdentities: [],
          failures: [{ worktreeId: failed.worktreeId, displayName: 'failed', message: 'locked' }]
        })
        .mockResolvedValueOnce({
          removedIds: [removed.worktreeId],
          removedIdentities: [getWorkspaceCleanupCandidateIdentity(removed)],
          failures: []
        }),
      [failed, removed]
    )
    commits.get(removed.worktreeId)?.mockImplementation(() => {
      throw new Error('activation failed')
    })

    await remove([failed.worktreeId])
    await expect(remove([removed.worktreeId])).resolves.toMatchObject({
      removedIds: [removed.worktreeId]
    })

    expect(commits.get(failed.worktreeId)).not.toHaveBeenCalled()
    expect(commits.get(removed.worktreeId)).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
