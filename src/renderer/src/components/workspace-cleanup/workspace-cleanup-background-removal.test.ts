import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startWorkspaceCleanupBackgroundRemoval } from './workspace-cleanup-background-removal'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'
import { getWorkspaceCleanupHostIdentity } from '../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn()
  }
}))

vi.mock('../sidebar/workspace-actions/deletion/preserved-branch-batch-toast', () => ({
  showPreservedBranchBatchToast: vi.fn()
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
})
