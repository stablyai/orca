import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import type {
  WorkspaceCleanupFailure,
  WorkspaceCleanupRemoveResult
} from '@/store/slices/workspace-cleanup'
import { translate } from '@/i18n/i18n'

export type WorkspaceCleanupRemovalSettlement =
  | { status: 'fulfilled'; result: WorkspaceCleanupRemoveResult }
  | { status: 'rejected'; error: unknown }

type WorkspaceCleanupRemovalPollResult =
  | WorkspaceCleanupRemovalSettlement
  | { status: 'unresolved' }

export type WorkspaceCleanupRemovalWaitResult =
  | WorkspaceCleanupRemovalSettlement
  | { status: 'unresolved'; settlement: Promise<WorkspaceCleanupRemovalSettlement> }

export async function waitForWorkspaceCleanupRemovalWithTimeout(
  promise: Promise<WorkspaceCleanupRemoveResult>,
  timeoutMs: number,
  settlementGraceMs: number
): Promise<WorkspaceCleanupRemovalWaitResult> {
  if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return promise.then<WorkspaceCleanupRemovalSettlement, WorkspaceCleanupRemovalSettlement>(
      (result) => ({ status: 'fulfilled', result }),
      (error: unknown) => ({ status: 'rejected', error })
    )
  }

  // Why: a timeout does not cancel renderer IPC. Preserve the eventual outcome
  // so a confirmation racing the deadline remains authoritative.
  const settlement = promise.then<
    WorkspaceCleanupRemovalSettlement,
    WorkspaceCleanupRemovalSettlement
  >(
    (result) => ({ status: 'fulfilled', result }),
    (error: unknown) => ({ status: 'rejected', error })
  )
  const initialOutcome = await pollWorkspaceCleanupRemoval(settlement, timeoutMs)
  const outcome =
    initialOutcome.status === 'unresolved' &&
    settlementGraceMs > 0 &&
    Number.isFinite(settlementGraceMs)
      ? await pollWorkspaceCleanupRemoval(settlement, settlementGraceMs)
      : initialOutcome

  return outcome.status === 'unresolved' ? { ...outcome, settlement } : outcome
}

export function getWorkspaceCleanupTimeoutFailure(
  candidate: WorkspaceCleanupCandidate
): WorkspaceCleanupFailure {
  return {
    worktreeId: candidate.worktreeId,
    displayName: candidate.displayName,
    message: translate(
      'auto.components.workspace.cleanup.backgroundRemoval.timedOut',
      'Removing {{value0}} is taking longer than expected. It will keep running in the background.',
      { value0: candidate.displayName }
    )
  }
}

export function trackWorkspaceCleanupLateSettlement(
  settlement: Promise<WorkspaceCleanupRemovalSettlement>,
  candidate: WorkspaceCleanupCandidate,
  reconcileBeforeBatchResult: (result: WorkspaceCleanupRemoveResult) => void,
  reportAfterBatchResult: (result: WorkspaceCleanupRemoveResult) => void
): () => void {
  const state: { reconcile: ((result: WorkspaceCleanupRemoveResult) => void) | null } = {
    reconcile: reconcileBeforeBatchResult
  }
  void settlement.then(createLateSettlementReporter(state, candidate, reportAfterBatchResult))
  // Why: a truly hung IPC promise can live for the renderer's lifetime. Drop
  // the batch-array closure once its initial result has been reported.
  return () => {
    state.reconcile = null
  }
}

function createLateSettlementReporter(
  state: { reconcile: ((result: WorkspaceCleanupRemoveResult) => void) | null },
  candidate: WorkspaceCleanupCandidate,
  reportAfterBatchResult: (result: WorkspaceCleanupRemoveResult) => void
): (settlement: WorkspaceCleanupRemovalSettlement) => void {
  return (settlement) => {
    const result = toWorkspaceCleanupRemoveResult(candidate, settlement)
    if (state.reconcile) {
      state.reconcile(result)
      return
    }
    reportAfterBatchResult(result)
  }
}

function toWorkspaceCleanupRemoveResult(
  candidate: WorkspaceCleanupCandidate,
  settlement: WorkspaceCleanupRemovalSettlement
): WorkspaceCleanupRemoveResult {
  if (settlement.status === 'fulfilled') {
    return settlement.result
  }
  return {
    removedIds: [],
    failures: [
      {
        worktreeId: candidate.worktreeId,
        displayName: candidate.displayName,
        message:
          settlement.error instanceof Error ? settlement.error.message : String(settlement.error)
      }
    ]
  }
}

async function pollWorkspaceCleanupRemoval(
  settlement: Promise<WorkspaceCleanupRemovalSettlement>,
  timeoutMs: number
): Promise<WorkspaceCleanupRemovalPollResult> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      settlement,
      new Promise<{ status: 'unresolved' }>((resolve) => {
        timeout = setTimeout(() => {
          resolve({ status: 'unresolved' })
        }, timeoutMs)
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}
