import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import type {
  WorkspaceCleanupFailure,
  WorkspaceCleanupRemoveResult
} from '@/store/slices/workspace-cleanup'
import { translate } from '@/i18n/i18n'

export type WorkspaceCleanupRemovalSettlement =
  | { status: 'fulfilled'; result: WorkspaceCleanupRemoveResult }
  | { status: 'rejected'; error: unknown }

export type WorkspaceCleanupRemovalWaitResult =
  | WorkspaceCleanupRemovalSettlement
  | { status: 'unresolved'; settlement: Promise<WorkspaceCleanupRemovalSettlement> }

export async function waitForWorkspaceCleanupRemovalWithTimeout(
  promise: Promise<WorkspaceCleanupRemoveResult>,
  timeoutMs: number,
  settlementGraceMs: number
): Promise<WorkspaceCleanupRemovalWaitResult> {
  const settlement = toWorkspaceCleanupRemovalSettlement(promise)
  if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return settlement
  }

  // Why: a timeout does not cancel renderer IPC, so the deadline is provisional;
  // the grace stretches it so a settlement racing the deadline stays authoritative.
  const graceMs =
    settlementGraceMs > 0 && Number.isFinite(settlementGraceMs) ? settlementGraceMs : 0
  const outcome = await pollWorkspaceCleanupRemoval(settlement, timeoutMs + graceMs)
  return outcome.status === 'unresolved' ? { status: 'unresolved', settlement } : outcome
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
  // Why: a truly hung IPC promise can live for the renderer's lifetime; detach
  // drops the reconcile closure (and the batch arrays it captures) at batch end.
  let reconcile: ((result: WorkspaceCleanupRemoveResult) => void) | null =
    reconcileBeforeBatchResult
  settlement
    .then((outcome) => {
      const result = toWorkspaceCleanupRemoveResult(candidate, outcome)
      if (reconcile) {
        reconcile(result)
        return
      }
      reportAfterBatchResult(result)
    })
    .catch((error: unknown) => {
      console.error('Workspace cleanup late settlement reporting failed', error)
    })
  return () => {
    reconcile = null
  }
}

function toWorkspaceCleanupRemovalSettlement(
  promise: Promise<WorkspaceCleanupRemoveResult>
): Promise<WorkspaceCleanupRemovalSettlement> {
  return promise.then<WorkspaceCleanupRemovalSettlement, WorkspaceCleanupRemovalSettlement>(
    (result) => ({ status: 'fulfilled', result }),
    (error: unknown) => ({ status: 'rejected', error })
  )
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
): Promise<WorkspaceCleanupRemovalSettlement | { status: 'unresolved' }> {
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
