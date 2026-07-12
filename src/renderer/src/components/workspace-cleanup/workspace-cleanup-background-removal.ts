import { toast } from 'sonner'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import type {
  WorkspaceCleanupFailure,
  WorkspaceCleanupRemoveOptions,
  WorkspaceCleanupRemoveResult
} from '@/store/slices/workspace-cleanup'
import { translate } from '@/i18n/i18n'
import {
  getSkippedAncestorMessage,
  isStrictWorkspaceCleanupDescendant,
  type SkippedWorkspaceCleanupAncestor
} from './workspace-cleanup-ancestor-skips'
import { reconcilePostBatchLateSettlement } from './workspace-cleanup-post-batch-late-settlement'
import {
  getWorkspaceCleanupTimeoutFailure,
  trackWorkspaceCleanupLateSettlement,
  waitForWorkspaceCleanupRemovalWithTimeout
} from './workspace-cleanup-removal-settlement'
import { showWorkspaceCleanupRemovalResultToasts } from './workspace-cleanup-removal-toasts'
import { reclassifySkippedWorkspaceCleanupAncestors } from './workspace-cleanup-skipped-ancestor-reclassification'

const DEFAULT_WORKSPACE_CLEANUP_REMOVAL_TIMEOUT_MS = 120_000
const DEFAULT_WORKSPACE_CLEANUP_SETTLEMENT_GRACE_MS = 5_000

export type WorkspaceCleanupRemovalProgress = {
  totalCount: number
  processedCount: number
  removedCount: number
  failedCount: number
}

export type WorkspaceCleanupBackgroundRemovalArgs = {
  candidates: readonly WorkspaceCleanupCandidate[]
  removeCandidates: (
    worktreeIds: readonly string[],
    options?: WorkspaceCleanupRemoveOptions
  ) => Promise<WorkspaceCleanupRemoveResult>
  onProgress: (progress: WorkspaceCleanupRemovalProgress) => void
  onResult?: (result: WorkspaceCleanupRemoveResult) => void
  // Why: the timeout is provisional because renderer IPC cannot be cancelled;
  // consumers need the eventual outcome to replace stale timeout UI.
  onLateResult?: (result: WorkspaceCleanupRemoveResult) => void
  onError?: (error: unknown) => void
  // Why: a row can fail before its removal starts (preflight failure or a
  // skipped nested workspace); report it now so its queued overlay can clear
  // instead of waiting for the whole batch to settle.
  onRowFailed?: (failure: WorkspaceCleanupFailure) => void
  removalTimeoutMs?: number
  removalSettlementGraceMs?: number
}

export function startWorkspaceCleanupBackgroundRemoval({
  candidates,
  removeCandidates,
  onProgress,
  onResult,
  onLateResult,
  onError,
  onRowFailed,
  removalTimeoutMs = DEFAULT_WORKSPACE_CLEANUP_REMOVAL_TIMEOUT_MS,
  removalSettlementGraceMs = DEFAULT_WORKSPACE_CLEANUP_SETTLEMENT_GRACE_MS
}: WorkspaceCleanupBackgroundRemovalArgs): void {
  if (candidates.length === 0) {
    try {
      onResult?.({ removedIds: [], failures: [] })
    } catch (callbackError) {
      console.error('Workspace cleanup result callback failed', callbackError)
    }
    return
  }

  const count = candidates.length
  const removedIds: string[] = []
  const failures: WorkspaceCleanupFailure[] = []
  const failedCandidates: WorkspaceCleanupCandidate[] = []
  const detachLateResultReconcilers: (() => void)[] = []
  // Why: rows past the removal deadline are still removing; their skip fallout
  // and batch toasts must not present them as definitive failures.
  const provisionallyBlocked = new Set<WorkspaceCleanupCandidate>()
  const pendingSettlementFailures = new Set<WorkspaceCleanupFailure>()
  const skippedAncestors: SkippedWorkspaceCleanupAncestor[] = []
  // Why: serialize post-batch late reconciles so concurrent child settlements
  // do not interleave ancestor reclassification and retries.
  let postBatchLateReconcileChain: Promise<void> = Promise.resolve()
  let processedCount = 0

  const emitProgress = (): void => {
    onProgress({
      totalCount: count,
      processedCount,
      removedCount: removedIds.length,
      failedCount: failures.length
    })
  }

  const reportFailures = (rowFailures: readonly WorkspaceCleanupFailure[]): void => {
    for (const failure of rowFailures) {
      failures.push(failure)
      try {
        onRowFailed?.(failure)
      } catch (callbackError) {
        console.error('Workspace cleanup row failure callback failed', callbackError)
      }
    }
  }

  const detachAllLateResultReconcilers = (): void => {
    for (const detach of detachLateResultReconcilers) {
      detach()
    }
  }

  emitProgress()

  // Why: keep the store's nested-worktree delete invariant even though progress
  // is emitted per row; children must be removed before parent workspaces.
  const queue = [...candidates].sort((a, b) => b.path.length - a.path.length)

  const findBlockingDescendants = (
    candidate: WorkspaceCleanupCandidate
  ): WorkspaceCleanupCandidate[] =>
    failedCandidates.filter((failedCandidate) =>
      isStrictWorkspaceCleanupDescendant(candidate, failedCandidate)
    )

  const skipBlockedAncestor = (
    candidate: WorkspaceCleanupCandidate,
    blockers: readonly WorkspaceCleanupCandidate[]
  ): void => {
    const provisional = blockers.every((blocker) => provisionallyBlocked.has(blocker))
    const failure: WorkspaceCleanupFailure = {
      worktreeId: candidate.worktreeId,
      displayName: candidate.displayName,
      message: getSkippedAncestorMessage(provisional)
    }
    if (provisional) {
      provisionallyBlocked.add(candidate)
    }
    failedCandidates.push(candidate)
    skippedAncestors.push({ candidate, failure, provisional })
    reportFailures([failure])
    processedCount += 1
    emitProgress()
  }

  // Why: a late child settlement can unblock or definitively doom skipped
  // ancestors; re-derive each skip from the current blocker set so the batch
  // never reports "could not be removed" for a row whose blocker succeeded.
  const resettleSkippedAncestors = (): void => {
    const { unblocked } = reclassifySkippedWorkspaceCleanupAncestors({
      skippedAncestors,
      findBlockingDescendants,
      provisionallyBlocked,
      failedCandidates,
      failures
    })
    for (const candidate of unblocked) {
      processedCount -= 1
      queue.push(candidate)
    }
  }

  const enqueuePostBatchLateSettlement = (
    settledCandidate: WorkspaceCleanupCandidate,
    timeoutFailure: WorkspaceCleanupFailure,
    lateResult: WorkspaceCleanupRemoveResult
  ): void => {
    postBatchLateReconcileChain = postBatchLateReconcileChain
      .then(async () => {
        const reconciled = await reconcilePostBatchLateSettlement({
          lateResult,
          settledCandidate,
          timeoutFailure,
          skippedAncestors,
          failedCandidates,
          failures,
          provisionallyBlocked,
          pendingSettlementFailures,
          removeCandidates
        })
        reportLateWorkspaceCleanupResult(reconciled, onLateResult)
      })
      .catch((error: unknown) => {
        console.error('Workspace cleanup post-batch late settlement failed', error)
      })
  }

  void (async () => {
    while (queue.length > 0) {
      const candidate = queue.shift()
      if (!candidate) {
        break
      }
      const blockers = findBlockingDescendants(candidate)
      if (blockers.length > 0) {
        skipBlockedAncestor(candidate, blockers)
        continue
      }
      try {
        const outcome = await waitForWorkspaceCleanupRemovalWithTimeout(
          removeCandidates([candidate.worktreeId], { approvedCandidates: [candidate] }),
          removalTimeoutMs,
          removalSettlementGraceMs
        )
        if (outcome.status === 'rejected') {
          throw outcome.error
        }
        if (outcome.status === 'unresolved') {
          const timeoutFailure = getWorkspaceCleanupTimeoutFailure(candidate)
          failedCandidates.push(candidate)
          provisionallyBlocked.add(candidate)
          pendingSettlementFailures.add(timeoutFailure)
          reportFailures([timeoutFailure])
          // Why: renderer IPC cannot be cancelled at the timeout boundary; keep
          // its authoritative settlement without unblocking ancestors early.
          // After the batch ends, detach switches to the post-batch path which
          // still holds skip state so ancestors can reclassify.
          detachLateResultReconcilers.push(
            trackWorkspaceCleanupLateSettlement(
              outcome.settlement,
              candidate,
              (lateResult) => {
                removeArrayEntry(failures, timeoutFailure)
                pendingSettlementFailures.delete(timeoutFailure)
                provisionallyBlocked.delete(candidate)
                removedIds.push(...lateResult.removedIds)
                reportFailures(lateResult.failures)
                if (lateResult.failures.length === 0) {
                  removeArrayEntry(failedCandidates, candidate)
                }
                resettleSkippedAncestors()
                emitProgress()
              },
              (lateResult) => {
                enqueuePostBatchLateSettlement(candidate, timeoutFailure, lateResult)
              }
            )
          )
          continue
        }
        const result = outcome.result
        removedIds.push(...result.removedIds)
        reportFailures(result.failures)
        if (result.failures.length > 0) {
          failedCandidates.push(candidate)
        }
      } catch (error: unknown) {
        failedCandidates.push(candidate)
        reportFailures([
          {
            worktreeId: candidate.worktreeId,
            displayName: candidate.displayName,
            message: error instanceof Error ? error.message : String(error)
          }
        ])
      } finally {
        processedCount += 1
        emitProgress()
      }
    }

    detachAllLateResultReconcilers()
    const result = { removedIds, failures }
    try {
      onResult?.(result)
    } catch (callbackError) {
      console.error('Workspace cleanup result callback failed', callbackError)
    }

    showWorkspaceCleanupRemovalResultToasts(result, pendingSettlementFailures)
  })().catch((error: unknown) => {
    detachAllLateResultReconcilers()
    onError?.(error)
    toast.error(
      translate(
        'auto.components.workspace.cleanup.backgroundRemoval.error',
        'Workspace cleanup failed'
      ),
      {
        description: error instanceof Error ? error.message : String(error)
      }
    )
  })
}

function reportLateWorkspaceCleanupResult(
  result: WorkspaceCleanupRemoveResult,
  onLateResult: WorkspaceCleanupBackgroundRemovalArgs['onLateResult']
): void {
  try {
    onLateResult?.(result)
  } catch (callbackError) {
    console.error('Workspace cleanup late result callback failed', callbackError)
  }
  showWorkspaceCleanupRemovalResultToasts(result)
}

function removeArrayEntry<T>(entries: T[], entry: T): void {
  const index = entries.indexOf(entry)
  if (index >= 0) {
    entries.splice(index, 1)
  }
}
