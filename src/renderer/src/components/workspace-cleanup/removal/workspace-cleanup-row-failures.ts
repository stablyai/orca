import type {
  WorkspaceCleanupFailure,
  WorkspaceCleanupRemoveResult
} from '@/store/slices/workspace-cleanup/workspace-cleanup-removal'
import { getWorkspaceCleanupFailureIdentity } from './run/workspace-cleanup-run-reporter'

export type WorkspaceCleanupRowFailures = Record<string, WorkspaceCleanupFailure>
export type WorkspaceCleanupRowAttempts = Map<string, { token: symbol; removed?: true }>
type BrowseSettlement = Pick<WorkspaceCleanupRemoveResult, 'removedIdentities' | 'failures'>

export function startWorkspaceCleanupRowAttempt(
  activeAttempts: WorkspaceCleanupRowAttempts,
  identities: readonly string[]
): {
  owns: (identity: string) => boolean
  canReportFailure: (identity: string) => boolean
  settle: (result: BrowseSettlement) => BrowseSettlement
} {
  const token = Symbol()
  for (const identity of identities) {
    activeAttempts.set(identity, { token })
  }
  const owns = (identity: string): boolean => activeAttempts.get(identity)?.token === token
  const canReportFailure = (identity: string): boolean => {
    const current = activeAttempts.get(identity)
    return current?.token === token && !current.removed
  }
  return {
    owns,
    canReportFailure,
    settle: ({ removedIdentities, failures }) => {
      const ownedFailures = failures.filter((failure) =>
        canReportFailure(getWorkspaceCleanupFailureIdentity(failure))
      )
      for (const identity of removedIdentities) {
        const current = activeAttempts.get(identity)
        if (current && current.token !== token) {
          // An authoritative deletion suppresses errors, but the retry still owns its phase.
          current.removed = true
        } else {
          activeAttempts.delete(identity)
        }
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
