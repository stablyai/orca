import { describe, expect, it, vi } from 'vitest'
import {
  trackWorkspaceCleanupLateSettlement,
  type WorkspaceCleanupRemovalSettlement
} from './workspace-cleanup-removal-settlement'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'

describe('workspace cleanup late settlement tracking', () => {
  it('detaches the batch callback and reports with a compact candidate identity', async () => {
    const candidate = makeCandidate()
    let resolveSettlement: (settlement: WorkspaceCleanupRemovalSettlement) => void = () => {}
    const settlement = new Promise<WorkspaceCleanupRemovalSettlement>((resolve) => {
      resolveSettlement = resolve
    })
    const reconcileBeforeBatchResult = vi.fn()
    const reportAfterBatchResult = vi.fn()
    const tracker = trackWorkspaceCleanupLateSettlement(
      settlement,
      candidate,
      reconcileBeforeBatchResult
    )

    expect(tracker.candidate).toEqual({
      worktreeId: candidate.worktreeId,
      displayName: candidate.displayName
    })
    expect(tracker.candidate).not.toBe(candidate)
    tracker.detach(reportAfterBatchResult)
    resolveSettlement({ status: 'rejected', error: new Error('remote removal failed') })
    await settlement
    await Promise.resolve()

    expect(reconcileBeforeBatchResult).not.toHaveBeenCalled()
    expect(reportAfterBatchResult).toHaveBeenCalledWith(
      { worktreeId: candidate.worktreeId, displayName: candidate.displayName },
      {
        removedIds: [],
        failures: [
          {
            worktreeId: candidate.worktreeId,
            displayName: candidate.displayName,
            message: 'remote removal failed'
          }
        ]
      }
    )
    expect(reportAfterBatchResult.mock.calls[0][0]).not.toBe(candidate)
  })
})
