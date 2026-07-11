import { toast } from 'sonner'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import type {
  WorkspaceCleanupFailure,
  WorkspaceCleanupRemoveOptions,
  WorkspaceCleanupRemoveResult
} from '@/store/slices/workspace-cleanup'
import { translate } from '@/i18n/i18n'
import {
  getWorkspaceCleanupTimeoutFailure,
  trackWorkspaceCleanupLateSettlement,
  waitForWorkspaceCleanupRemovalWithTimeout
} from './workspace-cleanup-removal-settlement'

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

  emitProgress()

  // Why: keep the store's nested-worktree delete invariant even though progress
  // is emitted per row; children must be removed before parent workspaces.
  const candidatesInRemovalOrder = [...candidates].sort((a, b) => b.path.length - a.path.length)

  void (async () => {
    for (const candidate of candidatesInRemovalOrder) {
      if (
        failedCandidates.some((failedCandidate) =>
          isStrictWorkspaceCleanupDescendant(candidate, failedCandidate)
        )
      ) {
        failedCandidates.push(candidate)
        reportFailures([
          {
            worktreeId: candidate.worktreeId,
            displayName: candidate.displayName,
            message: translate(
              'auto.components.workspace.cleanup.backgroundRemoval.skippedAncestor',
              'Skipped because a nested workspace could not be removed.'
            )
          }
        ])
        processedCount += 1
        emitProgress()
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
          reportFailures([timeoutFailure])
          // Why: renderer IPC cannot be cancelled at the timeout boundary. Keep
          // its authoritative settlement without letting an unknown child
          // outcome permit deletion of an ancestor.
          detachLateResultReconcilers.push(
            trackWorkspaceCleanupLateSettlement(
              outcome.settlement,
              candidate,
              (lateResult) => {
                const timeoutIndex = failures.indexOf(timeoutFailure)
                if (timeoutIndex >= 0) {
                  failures.splice(timeoutIndex, 1)
                }
                removedIds.push(...lateResult.removedIds)
                reportFailures(lateResult.failures)
                if (lateResult.failures.length === 0) {
                  const failedCandidateIndex = failedCandidates.indexOf(candidate)
                  if (failedCandidateIndex >= 0) {
                    failedCandidates.splice(failedCandidateIndex, 1)
                  }
                }
                emitProgress()
              },
              (lateResult) => reportLateWorkspaceCleanupResult(lateResult, onLateResult)
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

    for (const detach of detachLateResultReconcilers) {
      detach()
    }
    const result = { removedIds, failures }
    try {
      onResult?.(result)
    } catch (callbackError) {
      console.error('Workspace cleanup result callback failed', callbackError)
    }

    showWorkspaceCleanupRemovalResultToasts(result)
  })().catch((error: unknown) => {
    for (const detach of detachLateResultReconcilers) {
      detach()
    }
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

function showWorkspaceCleanupRemovalResultToasts(result: WorkspaceCleanupRemoveResult): void {
  if (result.removedIds.length > 0) {
    toast.success(
      translate(
        'auto.components.workspace.cleanup.backgroundRemoval.removed',
        'Removed workspaces: {{value0}}',
        { value0: result.removedIds.length }
      )
    )
  }
  if (result.failures.length > 0) {
    toast.error(
      translate(
        'auto.components.workspace.cleanup.backgroundRemoval.failed',
        'Workspaces not removed: {{value0}}',
        { value0: result.failures.length }
      ),
      { description: result.failures.map((failure) => failure.message).join('; ') }
    )
  }
}

function isStrictWorkspaceCleanupDescendant(
  parent: WorkspaceCleanupCandidate,
  child: WorkspaceCleanupCandidate
): boolean {
  return (
    parent.connectionId === child.connectionId &&
    isStrictWorkspaceCleanupDescendantPath(parent.path, child.path)
  )
}

function isStrictWorkspaceCleanupDescendantPath(parentPath: string, childPath: string): boolean {
  return (
    normalizeRuntimePathForComparison(parentPath) !==
      normalizeRuntimePathForComparison(childPath) && isPathInsideOrEqual(parentPath, childPath)
  )
}
