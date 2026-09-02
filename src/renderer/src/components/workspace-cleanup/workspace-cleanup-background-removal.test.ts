import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import {
  startWorkspaceCleanupBackgroundRemoval,
  type WorkspaceCleanupBackgroundRemovalArgs
} from './workspace-cleanup-background-removal'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'
import { getWorkspaceCleanupHostIdentity } from '../../../../shared/workspace-cleanup-host-identity'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn()
  }
}))

vi.mock('../sidebar/preserved-branch-batch-toast', () => ({
  showPreservedBranchBatchToast: vi.fn()
}))

import { showPreservedBranchBatchToast } from '../sidebar/preserved-branch-batch-toast'

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
    expect(onResult).toHaveBeenCalledWith({ removedIds: [], removedIdentities: [], failures: [] })
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

    resolveRemoval!({
      removedIds: [candidate.worktreeId],
      removedIdentities: [candidate.worktreeId],
      failures: []
    })
    await settleBackgroundRemoval()

    expect(onProgress).toHaveBeenLastCalledWith({
      totalCount: 1,
      processedCount: 1,
      removedCount: 1,
      failedCount: 0
    })
    expect(toast.success).not.toHaveBeenCalled()
    expect(onResult).toHaveBeenCalledWith({
      removedIds: [candidate.worktreeId],
      removedIdentities: [candidate.worktreeId],
      failures: []
    })
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
      .mockResolvedValueOnce({
        removedIds: [first.worktreeId],
        removedIdentities: [first.worktreeId],
        failures: []
      })
      .mockResolvedValueOnce({
        removedIds: [second.worktreeId],
        removedIdentities: [second.worktreeId],
        failures: []
      })
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

  it('reports all preserved branches in one cleanup result', async () => {
    const first = makeCandidate()
    const second = makeCandidate({
      worktreeId: 'repo-1::/repo/beta',
      displayName: 'beta',
      branch: 'beta',
      path: '/repo/beta'
    })
    const firstBranch = {
      worktreeId: first.worktreeId,
      branchName: 'feature/alpha',
      expectedHead: 'alpha-head'
    }
    const secondBranch = {
      worktreeId: second.worktreeId,
      branchName: 'feature/beta',
      expectedHead: 'beta-head'
    }
    const onResult = vi.fn()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [first, second],
      removeCandidates: vi
        .fn()
        .mockResolvedValueOnce({
          removedIds: [first.worktreeId],
          removedIdentities: [first.worktreeId],
          failures: [],
          preservedBranches: [firstBranch]
        })
        .mockResolvedValueOnce({
          removedIds: [second.worktreeId],
          removedIdentities: [second.worktreeId],
          failures: [],
          preservedBranches: [secondBranch]
        }),
      onProgress: vi.fn(),
      onResult
    })
    await settleBackgroundRemoval()

    expect(onResult).toHaveBeenCalledWith({
      removedIds: [first.worktreeId, second.worktreeId],
      removedIdentities: [first.worktreeId, second.worktreeId],
      failures: [],
      preservedBranches: [firstBranch, secondBranch]
    })
    expect(showPreservedBranchBatchToast).toHaveBeenCalledWith(2, [firstBranch, secondBranch])
    expect(toast.success).not.toHaveBeenCalledWith('Removed workspaces: 2')
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
      removedIdentities: [...worktreeIds],
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
      removedIdentities: [],
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
      removedIdentities: [],
      failures: [
        { worktreeId: child.worktreeId, displayName: child.displayName, message: 'busy' },
        {
          worktreeId: parent.worktreeId,
          executionHostId: 'local',
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
      removedIdentities: [],
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
        removedIdentities: [],
        failures: [
          {
            worktreeId: failedChild.worktreeId,
            executionHostId: 'local',
            displayName: failedChild.displayName,
            message: 'busy'
          }
        ]
      })
      .mockResolvedValueOnce({
        removedIds: [unrelatedParent.worktreeId],
        removedIdentities: [unrelatedParent.worktreeId],
        failures: []
      })
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
      removedIdentities: [unrelatedParent.worktreeId],
      failures: [
        {
          worktreeId: failedChild.worktreeId,
          executionHostId: 'local',
          displayName: 'child',
          message: 'busy'
        }
      ]
    })
  })

  it('does not skip a paired-runtime ancestor after another runtime child fails', async () => {
    const failedChild = makeCandidate({
      worktreeId: 'repo-1::/repo/parent/child',
      displayName: 'child',
      branch: 'child',
      path: '/repo/parent/child',
      executionHostId: 'runtime:hub-a'
    })
    const unrelatedParent = makeCandidate({
      worktreeId: 'repo-2::/repo/parent',
      repoId: 'repo-2',
      repoName: 'Repo 2',
      displayName: 'parent',
      branch: 'parent',
      path: '/repo/parent',
      executionHostId: 'runtime:hub-b'
    })
    const removeCandidates = vi
      .fn()
      .mockResolvedValueOnce({
        removedIds: [],
        removedIdentities: [],
        failures: [
          {
            worktreeId: failedChild.worktreeId,
            executionHostId: failedChild.executionHostId,
            displayName: failedChild.displayName,
            message: 'busy'
          }
        ]
      })
      .mockResolvedValueOnce({
        removedIds: [unrelatedParent.worktreeId],
        removedIdentities: [
          getWorkspaceCleanupHostIdentity('runtime:hub-b', unrelatedParent.worktreeId)
        ],
        failures: []
      })

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [unrelatedParent, failedChild],
      removeCandidates,
      onProgress: vi.fn()
    })
    await settleBackgroundRemoval()

    expect(removeCandidates).toHaveBeenNthCalledWith(1, [failedChild.worktreeId], {
      approvedCandidates: [failedChild]
    })
    expect(removeCandidates).toHaveBeenNthCalledWith(2, [unrelatedParent.worktreeId], {
      approvedCandidates: [unrelatedParent]
    })
  })

  it('reports removal failures after dismissing the pending toast', async () => {
    const candidate = makeCandidate()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [candidate],
      removeCandidates: vi.fn().mockResolvedValue({
        removedIds: [],
        removedIdentities: [],
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

  it('keeps removal outcome toasts when the result callback throws', async () => {
    const candidate = makeCandidate()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [candidate],
      removeCandidates: vi.fn().mockResolvedValue({
        removedIds: [candidate.worktreeId],
        removedIdentities: [candidate.worktreeId],
        failures: []
      }),
      onProgress: vi.fn(),
      onResult: () => {
        throw new Error('callback failed')
      },
      onError: vi.fn()
    })
    await settleBackgroundRemoval()

    expect(toast.success).not.toHaveBeenCalled()
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
          removedIdentities: [],
          failures: [
            { worktreeId: first.worktreeId, displayName: first.displayName, message: 'busy' }
          ]
        })
        .mockResolvedValueOnce({
          removedIds: [],
          removedIdentities: [],
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
