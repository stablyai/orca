import type {
  WorkspaceCleanupFailure,
  WorkspaceCleanupRemoveResult
} from '@/store/slices/workspace-cleanup/workspace-cleanup-removal'
import { getWorkspaceCleanupFailureIdentity } from './run/workspace-cleanup-run-reporter'

export type WorkspaceCleanupRowFailures = Record<string, WorkspaceCleanupFailure>
type BrowseSettlement = Pick<WorkspaceCleanupRemoveResult, 'removedIdentities' | 'failures'>

export function startWorkspaceCleanupRowAttempt(
  activeAttempts: Map<string, symbol>,
  identities: readonly string[]
): { owns: (identity: string) => boolean; settle: (result: BrowseSettlement) => BrowseSettlement } {
  const attempt = Symbol()
  for (const identity of identities) {
    activeAttempts.set(identity, attempt)
  }
  const owns = (identity: string): boolean => activeAttempts.get(identity) === attempt
  return {
    owns,
    settle: ({ removedIdentities, failures }) => {
      const ownedFailures = failures.filter((failure) =>
        owns(getWorkspaceCleanupFailureIdentity(failure))
      )
      // Late deletion still settles the actual workspace, even after another attempt starts.
      for (const identity of removedIdentities) {
        activeAttempts.delete(identity)
      }
      return { removedIdentities, failures: ownedFailures }
    }
  }
}

/**
 * Applies a settlement to Browse's per-row failures with the same rule as the run summary: a
 * provisional report (timeout, pending skip) never replaces a definitive failure, so a late or
 * repeated timeout cannot hide the real error or drop its Delete anyway. A new attempt clears
 * the row's entry first, so its own provisional reports still land.
 */
export function mergeWorkspaceCleanupRowFailures(
  current: WorkspaceCleanupRowFailures,
  result: BrowseSettlement
): WorkspaceCleanupRowFailures {
  if (result.removedIdentities.length === 0 && result.failures.length === 0) {
    return current
  }
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
