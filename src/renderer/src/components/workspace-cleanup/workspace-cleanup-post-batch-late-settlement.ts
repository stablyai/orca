import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import type {
  WorkspaceCleanupFailure,
  WorkspaceCleanupRemoveOptions,
  WorkspaceCleanupRemoveResult
} from '@/store/slices/workspace-cleanup'
import {
  getSkippedAncestorMessage,
  isStrictWorkspaceCleanupDescendant,
  type SkippedWorkspaceCleanupAncestor
} from './workspace-cleanup-ancestor-skips'
import { reclassifySkippedWorkspaceCleanupAncestors } from './workspace-cleanup-skipped-ancestor-reclassification'

export type PostBatchLateSettlementArgs = {
  lateResult: WorkspaceCleanupRemoveResult
  settledCandidate: WorkspaceCleanupCandidate
  timeoutFailure: WorkspaceCleanupFailure
  skippedAncestors: SkippedWorkspaceCleanupAncestor[]
  failedCandidates: WorkspaceCleanupCandidate[]
  failures: WorkspaceCleanupFailure[]
  provisionallyBlocked: Set<WorkspaceCleanupCandidate>
  pendingSettlementFailures: Set<WorkspaceCleanupFailure>
  removeCandidates: (
    worktreeIds: readonly string[],
    options?: WorkspaceCleanupRemoveOptions
  ) => Promise<WorkspaceCleanupRemoveResult>
}

// Why: once the batch detaches its mid-loop reconcilers, late child results must
// still reclassify ancestors and retry unblocked ones so rowFailures do not keep
// the provisional skip after the blocker settles.
export async function reconcilePostBatchLateSettlement({
  lateResult,
  settledCandidate,
  timeoutFailure,
  skippedAncestors,
  failedCandidates,
  failures,
  provisionallyBlocked,
  pendingSettlementFailures,
  removeCandidates
}: PostBatchLateSettlementArgs): Promise<WorkspaceCleanupRemoveResult> {
  removeArrayEntry(failures, timeoutFailure)
  pendingSettlementFailures.delete(timeoutFailure)
  provisionallyBlocked.delete(settledCandidate)
  if (lateResult.failures.length === 0) {
    removeArrayEntry(failedCandidates, settledCandidate)
  }

  const removedIds = [...lateResult.removedIds]
  const lateFailures = [...lateResult.failures]
  const findBlockingDescendants = (
    candidate: WorkspaceCleanupCandidate
  ): WorkspaceCleanupCandidate[] =>
    failedCandidates.filter((failedCandidate) =>
      isStrictWorkspaceCleanupDescendant(candidate, failedCandidate)
    )

  const { unblocked, updatedFailures } = reclassifySkippedWorkspaceCleanupAncestors({
    skippedAncestors,
    findBlockingDescendants,
    provisionallyBlocked,
    failedCandidates,
    failures
  })
  lateFailures.push(...updatedFailures)

  // Why: deepest descendants first so a failed parent re-blocks its ancestors
  // before those ancestors are retried.
  unblocked.sort((a, b) => b.path.length - a.path.length)
  for (const ancestor of unblocked) {
    const blockers = findBlockingDescendants(ancestor)
    if (blockers.length > 0) {
      const provisional = blockers.every((blocker) => provisionallyBlocked.has(blocker))
      const failure: WorkspaceCleanupFailure = {
        worktreeId: ancestor.worktreeId,
        displayName: ancestor.displayName,
        message: getSkippedAncestorMessage(provisional)
      }
      if (provisional) {
        provisionallyBlocked.add(ancestor)
      }
      failedCandidates.push(ancestor)
      skippedAncestors.push({ candidate: ancestor, failure, provisional })
      lateFailures.push(failure)
      continue
    }

    try {
      const result = await removeCandidates([ancestor.worktreeId], {
        approvedCandidates: [ancestor]
      })
      removedIds.push(...result.removedIds)
      if (result.failures.length > 0) {
        failedCandidates.push(ancestor)
        lateFailures.push(...result.failures)
      }
    } catch (error: unknown) {
      failedCandidates.push(ancestor)
      lateFailures.push({
        worktreeId: ancestor.worktreeId,
        displayName: ancestor.displayName,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return { removedIds, failures: lateFailures }
}

function removeArrayEntry<T>(entries: T[], entry: T): void {
  const index = entries.indexOf(entry)
  if (index >= 0) {
    entries.splice(index, 1)
  }
}
