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
import {
  getWorkspaceCleanupTimeoutFailure,
  trackWorkspaceCleanupLateSettlement,
  waitForWorkspaceCleanupRemovalWithTimeout,
  type WorkspaceCleanupLateSettlementCandidate,
  type WorkspaceCleanupLateSettlementReporter
} from './workspace-cleanup-removal-settlement'
import { reclassifySkippedWorkspaceCleanupAncestors } from './workspace-cleanup-skipped-ancestor-reclassification'

type WorkspaceCleanupRemoveCandidates = (
  worktreeIds: readonly string[],
  options?: WorkspaceCleanupRemoveOptions
) => Promise<WorkspaceCleanupRemoveResult>

type PostBatchLateSettlementState = {
  skippedAncestors: SkippedWorkspaceCleanupAncestor[]
  failedCandidates: WorkspaceCleanupCandidate[]
  failures: WorkspaceCleanupFailure[]
  provisionallyBlocked: Set<WorkspaceCleanupCandidate>
  removeCandidates: WorkspaceCleanupRemoveCandidates | null
  removalTimeoutMs: number
  removalSettlementGraceMs: number
}

export type PostBatchLateSettlementResultReporter = (
  result: WorkspaceCleanupRemoveResult,
  pendingSettlementFailures?: ReadonlySet<WorkspaceCleanupFailure>
) => void

export type PostBatchLateSettlementReporterSelector = (
  candidate: WorkspaceCleanupLateSettlementCandidate
) => WorkspaceCleanupLateSettlementReporter

export function createPostBatchLateSettlementReporter({
  skippedAncestors,
  failedCandidates,
  provisionallyBlocked,
  removeCandidates,
  removalTimeoutMs,
  removalSettlementGraceMs,
  reportResult
}: {
  skippedAncestors: readonly SkippedWorkspaceCleanupAncestor[]
  failedCandidates: readonly WorkspaceCleanupCandidate[]
  provisionallyBlocked: ReadonlySet<WorkspaceCleanupCandidate>
  removeCandidates: WorkspaceCleanupRemoveCandidates
  removalTimeoutMs: number
  removalSettlementGraceMs: number
  reportResult: PostBatchLateSettlementResultReporter
}): PostBatchLateSettlementReporterSelector {
  // Why: detached IPC promises can outlive the dialog; retain only unresolved
  // blockers and provisional skips, not the completed batch's result arrays.
  const retainedSkippedAncestors = skippedAncestors
    .filter((entry) => entry.provisional)
    .map((entry) => ({ ...entry, failure: { ...entry.failure } }))
  const retainedCandidates = failedCandidates.filter(
    (candidate) =>
      provisionallyBlocked.has(candidate) &&
      retainedSkippedAncestors.some(
        (entry) =>
          entry.candidate.worktreeId === candidate.worktreeId ||
          isStrictWorkspaceCleanupDescendant(entry.candidate, candidate)
      )
  )
  const state: PostBatchLateSettlementState = {
    skippedAncestors: retainedSkippedAncestors,
    failedCandidates: retainedCandidates,
    failures: retainedSkippedAncestors.map((entry) => entry.failure),
    provisionallyBlocked: new Set(retainedCandidates),
    removeCandidates,
    removalTimeoutMs,
    removalSettlementGraceMs
  }
  let reconcileChain: Promise<void> = Promise.resolve()
  const reportLateSettlement: WorkspaceCleanupLateSettlementReporter = (candidate, result) => {
    // Why: queue reconciliation before reporting so a presentation-layer error
    // cannot suppress ancestor retries; the report still runs synchronously.
    reconcileChain = reconcileChain
      .then(async () => {
        const reconciled = await reconcilePostBatchLateSettlement(
          state,
          candidate,
          result,
          reportLateSettlement
        )
        if (reconciled.result.removedIds.length > 0 || reconciled.result.failures.length > 0) {
          reportResult(reconciled.result, reconciled.pendingSettlementFailures)
        }
      })
      .catch((error: unknown) => {
        console.error('Workspace cleanup post-batch late settlement failed', error)
      })
    reportResult(result)
  }
  const retainedCandidateIds = new Set(retainedCandidates.map((candidate) => candidate.worktreeId))
  const reportWithoutReconciliation: WorkspaceCleanupLateSettlementReporter = (
    _candidate,
    result
  ) => {
    reportResult(result)
  }
  return (candidate) =>
    retainedCandidateIds.has(candidate.worktreeId)
      ? reportLateSettlement
      : reportWithoutReconciliation
}

async function reconcilePostBatchLateSettlement(
  state: PostBatchLateSettlementState,
  settledCandidateIdentity: WorkspaceCleanupLateSettlementCandidate,
  lateResult: WorkspaceCleanupRemoveResult,
  reportLateSettlement: WorkspaceCleanupLateSettlementReporter
): Promise<{
  result: WorkspaceCleanupRemoveResult
  pendingSettlementFailures?: ReadonlySet<WorkspaceCleanupFailure>
}> {
  const settledCandidate = state.failedCandidates.find(
    (candidate) => candidate.worktreeId === settledCandidateIdentity.worktreeId
  )
  if (settledCandidate) {
    state.provisionallyBlocked.delete(settledCandidate)
    if (lateResult.failures.length === 0) {
      removeArrayEntry(state.failedCandidates, settledCandidate)
    }
  }

  const removedIds: string[] = []
  const lateFailures: WorkspaceCleanupFailure[] = []
  const pendingSettlementFailures = new Set<WorkspaceCleanupFailure>()
  const findBlockingDescendants = (
    candidate: WorkspaceCleanupCandidate
  ): WorkspaceCleanupCandidate[] =>
    state.failedCandidates.filter((failedCandidate) =>
      isStrictWorkspaceCleanupDescendant(candidate, failedCandidate)
    )

  const { unblocked, updatedFailures } = reclassifySkippedWorkspaceCleanupAncestors({
    skippedAncestors: state.skippedAncestors,
    findBlockingDescendants,
    provisionallyBlocked: state.provisionallyBlocked,
    failedCandidates: state.failedCandidates,
    failures: state.failures
  })
  lateFailures.push(...updatedFailures)

  // Why: deepest descendants first so a failed parent re-blocks its ancestors
  // before those ancestors are retried.
  unblocked.sort((a, b) => b.path.length - a.path.length)
  for (const ancestor of unblocked) {
    const blockers = findBlockingDescendants(ancestor)
    if (blockers.length > 0) {
      const provisional = blockers.every((blocker) => state.provisionallyBlocked.has(blocker))
      const failure: WorkspaceCleanupFailure = {
        worktreeId: ancestor.worktreeId,
        displayName: ancestor.displayName,
        message: getSkippedAncestorMessage(provisional)
      }
      if (provisional) {
        state.provisionallyBlocked.add(ancestor)
      }
      state.failedCandidates.push(ancestor)
      state.skippedAncestors.push({ candidate: ancestor, failure, provisional })
      state.failures.push(failure)
      lateFailures.push(failure)
      continue
    }

    const removeCandidates = state.removeCandidates
    if (!removeCandidates) {
      continue
    }
    let removal: Promise<WorkspaceCleanupRemoveResult>
    try {
      removal = removeCandidates([ancestor.worktreeId], {
        approvedCandidates: [ancestor]
      })
    } catch (error: unknown) {
      state.failedCandidates.push(ancestor)
      lateFailures.push({
        worktreeId: ancestor.worktreeId,
        displayName: ancestor.displayName,
        message: error instanceof Error ? error.message : String(error)
      })
      continue
    }
    const outcome = await waitForWorkspaceCleanupRemovalWithTimeout(
      removal,
      state.removalTimeoutMs,
      state.removalSettlementGraceMs
    )
    if (outcome.status === 'unresolved') {
      const timeoutFailure = getWorkspaceCleanupTimeoutFailure(ancestor)
      state.failedCandidates.push(ancestor)
      state.provisionallyBlocked.add(ancestor)
      lateFailures.push(timeoutFailure)
      pendingSettlementFailures.add(timeoutFailure)
      const tracker = trackWorkspaceCleanupLateSettlement(outcome.settlement, ancestor, () => {})
      tracker.detach(reportLateSettlement)
      continue
    }
    const result =
      outcome.status === 'fulfilled'
        ? outcome.result
        : {
            removedIds: [],
            failures: [
              {
                worktreeId: ancestor.worktreeId,
                displayName: ancestor.displayName,
                message:
                  outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
              }
            ]
          }
    removedIds.push(...result.removedIds)
    if (result.failures.length > 0) {
      state.failedCandidates.push(ancestor)
      lateFailures.push(...result.failures)
    }
  }

  releaseSettledPostBatchState(state)
  return {
    result: { removedIds, failures: lateFailures },
    pendingSettlementFailures:
      pendingSettlementFailures.size > 0 ? pendingSettlementFailures : undefined
  }
}

function releaseSettledPostBatchState(state: PostBatchLateSettlementState): void {
  if (state.skippedAncestors.some((entry) => entry.provisional)) {
    return
  }
  // Why: once no provisional ancestor can change, remaining late settlements
  // only report themselves and must not pin removal or candidate state.
  state.skippedAncestors.length = 0
  state.failedCandidates.length = 0
  state.failures.length = 0
  state.provisionallyBlocked.clear()
  state.removeCandidates = null
}

function removeArrayEntry<T>(entries: T[], entry: T): void {
  const index = entries.indexOf(entry)
  if (index >= 0) {
    entries.splice(index, 1)
  }
}
