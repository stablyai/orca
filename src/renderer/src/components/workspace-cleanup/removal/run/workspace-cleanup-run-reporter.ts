import type {
  WorkspaceCleanupFailure,
  WorkspaceCleanupRemoveResult
} from '@/store/slices/workspace-cleanup/workspace-cleanup-removal'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupCandidate } from '../../../../../../shared/workspace-cleanup/workspace-cleanup'
import {
  getWorkspaceCleanupCandidateIdentity,
  getWorkspaceCleanupHostIdentity
} from '../../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import {
  useWorkspaceCleanupRunStore,
  type WorkspaceCleanupRunAttempts
} from './workspace-cleanup-run-store'

// A timed-out delete that never reports back would hold the run open forever.
export const WORKSPACE_CLEANUP_PROVISIONAL_CEILING_MS = 5 * 60_000

export function getWorkspaceCleanupFailureIdentity(failure: WorkspaceCleanupFailure): string {
  return failure.executionHostId
    ? getWorkspaceCleanupHostIdentity(failure.executionHostId, failure.worktreeId)
    : getWorkspaceCleanupCandidateIdentity({ worktreeId: failure.worktreeId })
}

/** Bridges one batch's callbacks to its run; each write is fenced by run id and row attempt. */
export function createWorkspaceCleanupRunReporter(started: {
  runId: number
  attempts: WorkspaceCleanupRunAttempts
}): {
  onRowStarted: (candidate: WorkspaceCleanupCandidate) => void
  onRowRemoved: (candidate: WorkspaceCleanupCandidate) => void
  onRowFailed: (failure: WorkspaceCleanupFailure) => void
  onResult: (result: WorkspaceCleanupRemoveResult) => void
  onLateResult: (result: WorkspaceCleanupRemoveResult) => void
  onError: (error?: unknown) => void
} {
  const { runId, attempts } = started
  const store = (): ReturnType<typeof useWorkspaceCleanupRunStore.getState> =>
    useWorkspaceCleanupRunStore.getState()
  const expiryTimers = new Set<number>()
  const settle = (failure: WorkspaceCleanupFailure): void => {
    const identity = getWorkspaceCleanupFailureIdentity(failure)
    if (!failure.provisional) {
      store().markRowFailed(runId, attempts, identity, failure)
      return
    }
    store().markRowProvisional(runId, attempts, identity)
    // Bound to this attempt: a later retry of the row is never expired by this timer.
    const timer = window.setTimeout(() => {
      expiryTimers.delete(timer)
      store().expireProvisionalRow(
        runId,
        attempts,
        identity,
        translate(
          'components.workspace.cleanup.deleting.unconfirmed',
          "Couldn't confirm this was deleted. Refresh to check."
        )
      )
    }, WORKSPACE_CLEANUP_PROVISIONAL_CEILING_MS)
    expiryTimers.add(timer)
  }
  const applyResult = (result: WorkspaceCleanupRemoveResult): void => {
    store().markRowsDeleted(runId, attempts, result.removedIdentities)
    result.failures.forEach(settle)
  }
  return {
    onRowStarted: (candidate) =>
      store().markRowDeleting(runId, attempts, getWorkspaceCleanupCandidateIdentity(candidate)),
    onRowRemoved: (candidate) =>
      store().markRowsDeleted(runId, attempts, [getWorkspaceCleanupCandidateIdentity(candidate)]),
    onRowFailed: settle,
    onResult: (result) => {
      applyResult(result)
      store().settleUnfinishedRows(runId, attempts)
    },
    onLateResult: applyResult,
    onError: (error) => {
      const run = store().run
      // A batch that owns its whole run just goes away; a retry fails only its own row.
      if (run?.id === runId && run.rows.length === attempts.size) {
        store().dismissRun(runId)
        return
      }
      const message = error instanceof Error ? error.message : String(error ?? '')
      for (const row of run?.rows ?? []) {
        if (attempts.has(row.identity)) {
          store().markRowFailed(runId, attempts, row.identity, {
            worktreeId: row.candidate.worktreeId,
            displayName: row.candidate.displayName,
            message
          })
        }
      }
    }
  }
}
