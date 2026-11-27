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
  // A physical retry starts a new generation. Its timer and provisional reports cannot reopen a settled failure.
  const generations = new Map<string, number>()
  const expiryTimers = new Map<string, number>()
  const settledFailures = new Set<string>()
  const nextGeneration = (identity: string): void => {
    const timer = expiryTimers.get(identity)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      expiryTimers.delete(identity)
    }
    settledFailures.delete(identity)
    generations.set(identity, (generations.get(identity) ?? 0) + 1)
  }
  const settle = (failure: WorkspaceCleanupFailure): void => {
    const identity = getWorkspaceCleanupFailureIdentity(failure)
    if (!failure.provisional) {
      nextGeneration(identity)
      settledFailures.add(identity)
      store().markRowFailed(runId, attempts, identity, failure)
      return
    }
    if (expiryTimers.has(identity) || settledFailures.has(identity)) {
      return
    }
    const generation = generations.get(identity) ?? 0
    store().markRowProvisional(runId, attempts, identity)
    const timer = window.setTimeout(() => {
      expiryTimers.delete(identity)
      if ((generations.get(identity) ?? 0) !== generation) {
        return
      }
      settledFailures.add(identity)
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
    expiryTimers.set(identity, timer)
  }
  const applyResult = (result: WorkspaceCleanupRemoveResult): void => {
    store().markRowsDeleted(runId, attempts, result.removedIdentities)
    result.failures.forEach(settle)
  }
  return {
    onRowStarted: (candidate) => {
      const identity = getWorkspaceCleanupCandidateIdentity(candidate)
      nextGeneration(identity)
      store().markRowDeleting(runId, attempts, identity)
    },
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
      const ownsWholeRun =
        run?.id === runId &&
        run.rows.length === attempts.size &&
        run.rows.every((row) => attempts.get(row.identity) === row.attempt)
      if (ownsWholeRun) {
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
