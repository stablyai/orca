import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import {
  startWorkspaceCleanupBackgroundRemoval,
  type WorkspaceCleanupBackgroundRemovalArgs
} from './workspace-cleanup-background-removal'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

async function settleBackgroundRemoval(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

describe('startWorkspaceCleanupBackgroundRemoval', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports an empty result without starting removal when there are no candidates', async () => {
    const removeCandidates = vi.fn()
    const onProgress = vi.fn()
    const onResult = vi.fn()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [],
      removeCandidates,
      onProgress,
      onResult
    })
    await settleBackgroundRemoval()

    expect(removeCandidates).not.toHaveBeenCalled()
    expect(onProgress).not.toHaveBeenCalled()
    expect(onResult).toHaveBeenCalledWith({ removedIds: [], failures: [] })
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('reports deletion progress while the slow removal promise is pending', async () => {
    let resolveRemoval: (
      result: Awaited<ReturnType<WorkspaceCleanupBackgroundRemovalArgs['removeCandidates']>>
    ) => void
    const removeCandidates = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<WorkspaceCleanupBackgroundRemovalArgs['removeCandidates']>>>(
          (resolve) => {
            resolveRemoval = resolve
          }
        )
    )
    const onProgress = vi.fn()
    const onResult = vi.fn()
    const candidate = makeCandidate()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [candidate],
      removeCandidates,
      onProgress,
      onResult
    })

    expect(removeCandidates).toHaveBeenCalledWith([candidate.worktreeId], {
      approvedCandidates: [candidate]
    })
    expect(onProgress).toHaveBeenCalledWith({
      totalCount: 1,
      processedCount: 0,
      removedCount: 0,
      failedCount: 0
    })
    expect(onResult).not.toHaveBeenCalled()

    resolveRemoval!({ removedIds: [candidate.worktreeId], failures: [] })
    await settleBackgroundRemoval()

    expect(onProgress).toHaveBeenLastCalledWith({
      totalCount: 1,
      processedCount: 1,
      removedCount: 1,
      failedCount: 0
    })
    expect(toast.success).toHaveBeenCalled()
    expect(onResult).toHaveBeenCalledWith({ removedIds: [candidate.worktreeId], failures: [] })
  })

  it('removes candidates one at a time for per-row progress', async () => {
    const first = makeCandidate()
    const second = makeCandidate({
      worktreeId: 'repo-1::/repo/beta',
      displayName: 'beta',
      branch: 'beta',
      path: '/repo/beta'
    })
    const removeCandidates = vi
      .fn()
      .mockResolvedValueOnce({ removedIds: [first.worktreeId], failures: [] })
      .mockResolvedValueOnce({ removedIds: [second.worktreeId], failures: [] })
    const onProgress = vi.fn()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [first, second],
      removeCandidates,
      onProgress
    })
    await settleBackgroundRemoval()

    expect(removeCandidates).toHaveBeenNthCalledWith(1, [first.worktreeId], {
      approvedCandidates: [first]
    })
    expect(removeCandidates).toHaveBeenNthCalledWith(2, [second.worktreeId], {
      approvedCandidates: [second]
    })
    expect(onProgress).toHaveBeenLastCalledWith({
      totalCount: 2,
      processedCount: 2,
      removedCount: 2,
      failedCount: 0
    })
  })

  it('removes nested candidates before their parent workspace', async () => {
    const parent = makeCandidate({
      worktreeId: 'repo-1::/repo/parent',
      displayName: 'parent',
      branch: 'parent',
      path: '/repo/parent'
    })
    const child = makeCandidate({
      worktreeId: 'repo-1::/repo/parent/child',
      displayName: 'child',
      branch: 'child',
      path: '/repo/parent/child'
    })
    const removeCandidates = vi.fn(async (worktreeIds: readonly string[]) => ({
      removedIds: [...worktreeIds],
      failures: []
    }))

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [parent, child],
      removeCandidates,
      onProgress: vi.fn()
    })
    await settleBackgroundRemoval()

    expect(removeCandidates).toHaveBeenNthCalledWith(1, [child.worktreeId], {
      approvedCandidates: [child]
    })
    expect(removeCandidates).toHaveBeenNthCalledWith(2, [parent.worktreeId], {
      approvedCandidates: [parent]
    })
  })

  it('skips an ancestor after a nested workspace removal fails', async () => {
    const parent = makeCandidate({
      worktreeId: 'repo-1::C:\\repo\\parent',
      displayName: 'parent',
      branch: 'parent',
      path: 'C:\\repo\\parent'
    })
    const child = makeCandidate({
      worktreeId: 'repo-1::C:\\repo\\parent\\child',
      displayName: 'child',
      branch: 'child',
      path: 'C:\\repo\\parent\\child'
    })
    const removeCandidates = vi.fn().mockResolvedValueOnce({
      removedIds: [],
      failures: [{ worktreeId: child.worktreeId, displayName: child.displayName, message: 'busy' }]
    })
    const onProgress = vi.fn()
    const onResult = vi.fn()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [parent, child],
      removeCandidates,
      onProgress,
      onResult
    })
    await settleBackgroundRemoval()

    expect(removeCandidates).toHaveBeenCalledTimes(1)
    expect(removeCandidates).toHaveBeenCalledWith([child.worktreeId], {
      approvedCandidates: [child]
    })
    expect(onProgress).toHaveBeenLastCalledWith({
      totalCount: 2,
      processedCount: 2,
      removedCount: 0,
      failedCount: 2
    })
    expect(onResult).toHaveBeenCalledWith({
      removedIds: [],
      failures: [
        { worktreeId: child.worktreeId, displayName: child.displayName, message: 'busy' },
        {
          worktreeId: parent.worktreeId,
          displayName: parent.displayName,
          message: 'Skipped because a nested workspace could not be removed.'
        }
      ]
    })
  })

  it('reports each failure as it happens so queued rows can clear before the batch ends', async () => {
    const parent = makeCandidate({
      worktreeId: 'repo-1::/repo/parent',
      displayName: 'parent',
      branch: 'parent',
      path: '/repo/parent'
    })
    const child = makeCandidate({
      worktreeId: 'repo-1::/repo/parent/child',
      displayName: 'child',
      branch: 'child',
      path: '/repo/parent/child'
    })
    const removeCandidates = vi.fn().mockResolvedValueOnce({
      removedIds: [],
      failures: [{ worktreeId: child.worktreeId, displayName: child.displayName, message: 'busy' }]
    })
    const onRowFailed = vi.fn()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [parent, child],
      removeCandidates,
      onProgress: vi.fn(),
      onRowFailed
    })
    await settleBackgroundRemoval()

    // Child fails at removal (per-row result), then parent is skipped as its
    // ancestor — both reported incrementally, not only in the final result.
    expect(onRowFailed.mock.calls.map(([failure]) => failure.worktreeId)).toEqual([
      child.worktreeId,
      parent.worktreeId
    ])
  })

  it('does not skip same-path ancestors from another connection after a nested failure', async () => {
    const failedChild = makeCandidate({
      worktreeId: 'repo-1::/repo/parent/child',
      displayName: 'child',
      branch: 'child',
      path: '/repo/parent/child',
      connectionId: 'ssh-a'
    })
    const unrelatedParent = makeCandidate({
      worktreeId: 'repo-2::/repo/parent',
      repoId: 'repo-2',
      repoName: 'Repo 2',
      displayName: 'parent',
      branch: 'parent',
      path: '/repo/parent',
      connectionId: 'ssh-b'
    })
    const removeCandidates = vi
      .fn()
      .mockResolvedValueOnce({
        removedIds: [],
        failures: [
          {
            worktreeId: failedChild.worktreeId,
            displayName: failedChild.displayName,
            message: 'busy'
          }
        ]
      })
      .mockResolvedValueOnce({ removedIds: [unrelatedParent.worktreeId], failures: [] })
    const onResult = vi.fn()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [unrelatedParent, failedChild],
      removeCandidates,
      onProgress: vi.fn(),
      onResult
    })
    await settleBackgroundRemoval()

    expect(removeCandidates).toHaveBeenNthCalledWith(1, [failedChild.worktreeId], {
      approvedCandidates: [failedChild]
    })
    expect(removeCandidates).toHaveBeenNthCalledWith(2, [unrelatedParent.worktreeId], {
      approvedCandidates: [unrelatedParent]
    })
    expect(onResult).toHaveBeenCalledWith({
      removedIds: [unrelatedParent.worktreeId],
      failures: [{ worktreeId: failedChild.worktreeId, displayName: 'child', message: 'busy' }]
    })
  })

  it('reports removal failures after dismissing the pending toast', async () => {
    const candidate = makeCandidate()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [candidate],
      removeCandidates: vi.fn().mockResolvedValue({
        removedIds: [],
        failures: [
          { worktreeId: candidate.worktreeId, displayName: candidate.displayName, message: 'busy' }
        ]
      }),
      onProgress: vi.fn()
    })
    await settleBackgroundRemoval()

    expect(toast.error).toHaveBeenCalledWith(
      'Workspaces not removed: 1',
      expect.objectContaining({ description: 'busy' })
    )
  })

  it('times out a stalled row removal and continues reporting progress', async () => {
    vi.useFakeTimers()
    const candidate = makeCandidate()
    const onProgress = vi.fn()
    const onResult = vi.fn()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [candidate],
      removeCandidates: vi.fn(
        () =>
          new Promise<
            Awaited<ReturnType<WorkspaceCleanupBackgroundRemovalArgs['removeCandidates']>>
          >(() => undefined)
      ),
      onProgress,
      onResult,
      removalTimeoutMs: 5
    })

    await vi.advanceTimersByTimeAsync(5)
    await settleBackgroundRemoval()

    expect(onProgress).toHaveBeenLastCalledWith({
      totalCount: 1,
      processedCount: 1,
      removedCount: 0,
      failedCount: 1
    })
    expect(onResult).toHaveBeenCalledWith({
      removedIds: [],
      failures: [
        {
          worktreeId: candidate.worktreeId,
          displayName: candidate.displayName,
          message:
            'Removing alpha is taking longer than expected. It will keep running in the background.'
        }
      ]
    })
  })

  it('keeps removal outcome toasts when the result callback throws', async () => {
    const candidate = makeCandidate()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [candidate],
      removeCandidates: vi.fn().mockResolvedValue({
        removedIds: [candidate.worktreeId],
        failures: []
      }),
      onProgress: vi.fn(),
      onResult: () => {
        throw new Error('callback failed')
      },
      onError: vi.fn()
    })
    await settleBackgroundRemoval()

    expect(toast.success).toHaveBeenCalledWith('Removed workspaces: 1')
    expect(toast.error).not.toHaveBeenCalledWith(
      'Workspace cleanup failed',
      expect.objectContaining({ description: 'callback failed' })
    )
  })

  it('shows every failure message in the failure toast description', async () => {
    const first = makeCandidate()
    const second = makeCandidate({
      worktreeId: 'repo-1::/repo/beta',
      displayName: 'beta',
      branch: 'beta',
      path: '/repo/beta'
    })

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [first, second],
      removeCandidates: vi
        .fn()
        .mockResolvedValueOnce({
          removedIds: [],
          failures: [
            { worktreeId: first.worktreeId, displayName: first.displayName, message: 'busy' }
          ]
        })
        .mockResolvedValueOnce({
          removedIds: [],
          failures: [
            { worktreeId: second.worktreeId, displayName: second.displayName, message: 'dirty' }
          ]
        }),
      onProgress: vi.fn()
    })
    await settleBackgroundRemoval()

    expect(toast.error).toHaveBeenCalledWith(
      'Workspaces not removed: 2',
      expect.objectContaining({ description: 'busy; dirty' })
    )
  })
})
