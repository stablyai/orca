import type {
  WorkspaceCleanupFailure,
  WorkspaceCleanupRemoveResult
} from '@/store/slices/workspace-cleanup/workspace-cleanup-removal'
import { getWorkspaceCleanupFailureIdentity } from './run/workspace-cleanup-run-reporter'

export type WorkspaceCleanupRowFailures = Record<string, WorkspaceCleanupFailure>

/**
 * Applies a settlement to Browse's per-row failures with the same rule as the run summary: a
 * provisional report (timeout, pending skip) never replaces a definitive failure, so a late or
 * repeated timeout cannot hide the real error or drop its Delete anyway. A new attempt clears
 * the row's entry first, so its own provisional reports still land.
 */
export function mergeWorkspaceCleanupRowFailures(
  current: WorkspaceCleanupRowFailures,
  result: Pick<WorkspaceCleanupRemoveResult, 'removedIdentities' | 'failures'>
): WorkspaceCleanupRowFailures {
  const next = { ...current }
  for (const identity of result.removedIdentities) {
    delete next[identity]
  }
  for (const failure of result.failures) {
    const identity = getWorkspaceCleanupFailureIdentity(failure)
    const existing = next[identity]
    if (failure.provisional && existing && !existing.provisional) {
      continue
    }
    next[identity] = failure
  }
  return next
}
