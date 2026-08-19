/**
 * Timeout-boundary behavior of the cleanup removal batch: renderer IPC cannot be
 * cancelled, so a row past its deadline stays provisional and its authoritative
 * settlement — success or failure — must still reconcile the batch's row state,
 * its ancestor skips, and its toasts. Split from the batch-behavior suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { WorkspaceCleanupRemoveResult } from '@/store/slices/workspace-cleanup'
import { startWorkspaceCleanupBackgroundRemoval } from './workspace-cleanup-background-removal'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn()
  }
}))

async function settleBackgroundRemoval(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

describe('workspace cleanup removal timeout recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses a success confirmed after the initial timeout and proceeds with its parent', async () => {
    vi.useFakeTimers()
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
    let resolveChild: (result: WorkspaceCleanupRemoveResult) => void = () => {}
    const removeCandidates = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<WorkspaceCleanupRemoveResult>((resolve) => {
            resolveChild = resolve
          })
      )
      .mockResolvedValueOnce({
        removedIds: [parent.worktreeId],
        removedIdentities: [parent.worktreeId],
        failures: []
      })
    const onResult = vi.fn()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [parent, child],
      removeCandidates,
      onProgress: vi.fn(),
      onResult,
      removalTimeoutMs: 5,
      removalSettlementGraceMs: 5
    })

    await vi.advanceTimersByTimeAsync(5)
    resolveChild({
      removedIds: [child.worktreeId],
      removedIdentities: [child.worktreeId],
      failures: []
    })
    await settleBackgroundRemoval()

    expect(removeCandidates).toHaveBeenNthCalledWith(2, [parent.worktreeId], {
      approvedCandidates: [parent]
    })
    expect(onResult).toHaveBeenCalledWith({
      removedIds: [child.worktreeId, parent.worktreeId],
      removedIdentities: [child.worktreeId, parent.worktreeId],
      failures: []
    })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('reports a definitive late failure and skips its parent', async () => {
    vi.useFakeTimers()
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
    let rejectChild: (error: Error) => void = () => {}
    const removeCandidates = vi.fn(
      () =>
        new Promise<WorkspaceCleanupRemoveResult>((_resolve, reject) => {
          rejectChild = reject
        })
    )
    const onResult = vi.fn()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [parent, child],
      removeCandidates,
      onProgress: vi.fn(),
      onResult,
      removalTimeoutMs: 5,
      removalSettlementGraceMs: 5
    })

    await vi.advanceTimersByTimeAsync(5)
    rejectChild(new Error('remote removal failed'))
    await settleBackgroundRemoval()

    expect(removeCandidates).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith({
      removedIds: [],
      removedIdentities: [],
      failures: [
        {
          worktreeId: child.worktreeId,
          executionHostId: 'local',
          displayName: child.displayName,
          message: 'remote removal failed'
        },
        {
          worktreeId: parent.worktreeId,
          executionHostId: 'local',
          displayName: parent.displayName,
          message: 'Skipped because a nested workspace could not be removed.'
        }
      ]
    })
  })

  it('reports a timeout, skips its parent, then reports the authoritative result', async () => {
    vi.useFakeTimers()
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
    let resolveChild: (result: WorkspaceCleanupRemoveResult) => void = () => {}
    const removeCandidates = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<WorkspaceCleanupRemoveResult>((resolve) => {
            resolveChild = resolve
          })
      )
      .mockResolvedValueOnce({
        removedIds: [parent.worktreeId],
        removedIdentities: [parent.worktreeId],
        failures: []
      })
    const onProgress = vi.fn()
    const onResult = vi.fn()
    const onLateResult = vi.fn()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [parent, child],
      removeCandidates,
      onProgress,
      onResult,
      onLateResult,
      removalTimeoutMs: 5,
      removalSettlementGraceMs: 5
    })

    await vi.advanceTimersByTimeAsync(5)
    expect(onResult).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5)
    await settleBackgroundRemoval()

    expect(removeCandidates).toHaveBeenCalledTimes(1)
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
        {
          worktreeId: child.worktreeId,
          executionHostId: 'local',
          displayName: child.displayName,
          message:
            'Removing child is taking longer than expected. It will keep running in the background.'
        },
        {
          worktreeId: parent.worktreeId,
          executionHostId: 'local',
          displayName: parent.displayName,
          message: 'Skipped because a nested workspace has not finished removing.'
        }
      ]
    })
    // The still-pending row is reported as still removing, not as a failure.
    expect(toast.info).toHaveBeenCalledWith('Still removing workspaces: 1')
    expect(toast.error).toHaveBeenCalledWith(
      'Workspaces not removed: 1',
      expect.objectContaining({
        description: 'Skipped because a nested workspace has not finished removing.'
      })
    )

    resolveChild({
      removedIds: [child.worktreeId],
      removedIdentities: [child.worktreeId],
      failures: []
    })
    await settleBackgroundRemoval()

    // Why: post-batch child success must reclassify the provisional parent skip
    // and retry the parent so rowFailures do not keep the stale skip message.
    expect(removeCandidates).toHaveBeenNthCalledWith(2, [parent.worktreeId], {
      approvedCandidates: [parent]
    })
    expect(onResult).toHaveBeenCalledTimes(1)
    expect(onLateResult).toHaveBeenNthCalledWith(1, {
      removedIds: [child.worktreeId],
      removedIdentities: [child.worktreeId],
      failures: []
    })
    expect(onLateResult).toHaveBeenNthCalledWith(2, {
      removedIds: [parent.worktreeId],
      removedIdentities: [parent.worktreeId],
      failures: []
    })
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('hardens a provisional parent skip after the child late-fails post-batch', async () => {
    vi.useFakeTimers()
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
    let rejectChild: (error: Error) => void = () => {}
    const onLateResult = vi.fn()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [parent, child],
      removeCandidates: vi.fn(
        () =>
          new Promise<WorkspaceCleanupRemoveResult>((_resolve, reject) => {
            rejectChild = reject
          })
      ),
      onProgress: vi.fn(),
      onResult: vi.fn(),
      onLateResult,
      removalTimeoutMs: 5,
      removalSettlementGraceMs: 5
    })

    await vi.advanceTimersByTimeAsync(10)
    await settleBackgroundRemoval()
    rejectChild(new Error('remote removal failed'))
    await settleBackgroundRemoval()

    expect(onLateResult).toHaveBeenNthCalledWith(1, {
      removedIds: [],
      removedIdentities: [],
      failures: [
        expect.objectContaining({
          worktreeId: child.worktreeId,
          message: 'remote removal failed'
        })
      ]
    })
    expect(onLateResult).toHaveBeenNthCalledWith(2, {
      removedIds: [],
      removedIdentities: [],
      failures: [
        expect.objectContaining({
          worktreeId: parent.worktreeId,
          message: 'Skipped because a nested workspace could not be removed.'
        })
      ]
    })
  })

  it('retries a skipped parent after its blocking child succeeds mid-batch', async () => {
    vi.useFakeTimers()
    const parent = makeCandidate({
      worktreeId: 'repo-1::/rp/parent',
      displayName: 'parent',
      branch: 'parent',
      path: '/rp/parent'
    })
    const child = makeCandidate({
      worktreeId: 'repo-1::/rp/parent/c',
      displayName: 'child',
      branch: 'child',
      path: '/rp/parent/c'
    })
    const unrelated = makeCandidate({
      worktreeId: 'repo-1::/zz',
      displayName: 'other',
      branch: 'other',
      path: '/zz'
    })
    let resolveChild: (result: WorkspaceCleanupRemoveResult) => void = () => {}
    let resolveUnrelated: (result: WorkspaceCleanupRemoveResult) => void = () => {}
    const removeCandidates = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<WorkspaceCleanupRemoveResult>((resolve) => {
            resolveChild = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<WorkspaceCleanupRemoveResult>((resolve) => {
            resolveUnrelated = resolve
          })
      )
      .mockResolvedValueOnce({
        removedIds: [parent.worktreeId],
        removedIdentities: [parent.worktreeId],
        failures: []
      })
    const onResult = vi.fn()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [parent, child, unrelated],
      removeCandidates,
      onProgress: vi.fn(),
      onResult,
      removalTimeoutMs: 5,
      removalSettlementGraceMs: 5
    })

    // Child times out, the parent is provisionally skipped, and the loop is
    // held open by the unrelated row when the child's success reconciles.
    await vi.advanceTimersByTimeAsync(10)
    expect(removeCandidates).toHaveBeenCalledTimes(2)
    resolveChild({
      removedIds: [child.worktreeId],
      removedIdentities: [child.worktreeId],
      failures: []
    })
    await settleBackgroundRemoval()
    resolveUnrelated({
      removedIds: [unrelated.worktreeId],
      removedIdentities: [unrelated.worktreeId],
      failures: []
    })
    await settleBackgroundRemoval()

    expect(removeCandidates).toHaveBeenNthCalledWith(3, [parent.worktreeId], {
      approvedCandidates: [parent]
    })
    expect(onResult).toHaveBeenCalledWith({
      removedIds: [child.worktreeId, unrelated.worktreeId, parent.worktreeId],
      removedIdentities: [child.worktreeId, unrelated.worktreeId, parent.worktreeId],
      failures: []
    })
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('hardens a provisional skip into a definitive one after the child late-fails mid-batch', async () => {
    vi.useFakeTimers()
    const parent = makeCandidate({
      worktreeId: 'repo-1::/rp/parent',
      displayName: 'parent',
      branch: 'parent',
      path: '/rp/parent'
    })
    const child = makeCandidate({
      worktreeId: 'repo-1::/rp/parent/c',
      displayName: 'child',
      branch: 'child',
      path: '/rp/parent/c'
    })
    const unrelated = makeCandidate({
      worktreeId: 'repo-1::/zz',
      displayName: 'other',
      branch: 'other',
      path: '/zz'
    })
    let rejectChild: (error: Error) => void = () => {}
    let resolveUnrelated: (result: WorkspaceCleanupRemoveResult) => void = () => {}
    const removeCandidates = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<WorkspaceCleanupRemoveResult>((_resolve, reject) => {
            rejectChild = reject
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<WorkspaceCleanupRemoveResult>((resolve) => {
            resolveUnrelated = resolve
          })
      )
    const onResult = vi.fn()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [parent, child, unrelated],
      removeCandidates,
      onProgress: vi.fn(),
      onResult,
      removalTimeoutMs: 5,
      removalSettlementGraceMs: 5
    })

    await vi.advanceTimersByTimeAsync(10)
    rejectChild(new Error('remote removal failed'))
    await settleBackgroundRemoval()
    resolveUnrelated({
      removedIds: [unrelated.worktreeId],
      removedIdentities: [unrelated.worktreeId],
      failures: []
    })
    await settleBackgroundRemoval()

    expect(removeCandidates).toHaveBeenCalledTimes(2)
    expect(onResult).toHaveBeenCalledWith({
      removedIds: [unrelated.worktreeId],
      removedIdentities: [unrelated.worktreeId],
      failures: [
        {
          worktreeId: parent.worktreeId,
          executionHostId: 'local',
          displayName: parent.displayName,
          message: 'Skipped because a nested workspace could not be removed.'
        },
        {
          worktreeId: child.worktreeId,
          executionHostId: 'local',
          displayName: child.displayName,
          message: 'remote removal failed'
        }
      ]
    })
    expect(toast.error).toHaveBeenCalledWith(
      'Workspaces not removed: 2',
      expect.objectContaining({
        description:
          'Skipped because a nested workspace could not be removed.; remote removal failed'
      })
    )
  })

  it('reports an authoritative rejection after the timeout result', async () => {
    vi.useFakeTimers()
    const candidate = makeCandidate()
    let rejectRemoval: (error: Error) => void = () => {}
    const onLateResult = vi.fn()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [candidate],
      removeCandidates: vi.fn(
        () =>
          new Promise<WorkspaceCleanupRemoveResult>((_resolve, reject) => {
            rejectRemoval = reject
          })
      ),
      onProgress: vi.fn(),
      onLateResult,
      removalTimeoutMs: 5,
      removalSettlementGraceMs: 5
    })

    await vi.advanceTimersByTimeAsync(10)
    rejectRemoval(new Error('remote removal failed'))
    await settleBackgroundRemoval()

    expect(onLateResult).toHaveBeenCalledWith({
      removedIds: [],
      removedIdentities: [],
      failures: [expect.objectContaining({ message: 'remote removal failed' })]
    })
    expect(toast.error).toHaveBeenLastCalledWith(
      'Workspaces not removed: 1',
      expect.objectContaining({ description: 'remote removal failed' })
    )
  })
})
