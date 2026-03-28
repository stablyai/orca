import type { AppState } from '../types'
import type { PRCheckDetail, CheckStatus } from '../../../../shared/types'

export function normalizeBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

export function deriveCheckStatusFromChecks(checks: PRCheckDetail[]): CheckStatus {
  if (checks.length === 0) {
    return 'neutral'
  }

  let hasPending = false

  for (const check of checks) {
    if (
      check.conclusion === 'failure' ||
      check.conclusion === 'timed_out' ||
      check.conclusion === 'cancelled'
    ) {
      return 'failure'
    }

    if (
      check.status === 'queued' ||
      check.status === 'in_progress' ||
      check.conclusion === 'pending'
    ) {
      hasPending = true
    }
  }

  return hasPending ? 'pending' : 'success'
}

export function syncPRChecksStatus(
  state: AppState,
  repoPath: string,
  branch: string | undefined,
  checks: PRCheckDetail[]
): Partial<AppState> | null {
  if (!branch) {
    return null
  }

  const prCacheKey = `${repoPath}::${normalizeBranchName(branch)}`
  const prEntry = state.prCache[prCacheKey]
  if (!prEntry?.data) {
    return null
  }

  const nextStatus = deriveCheckStatusFromChecks(checks)
  if (prEntry.data.checksStatus === nextStatus) {
    return null
  }

  return {
    prCache: {
      ...state.prCache,
      [prCacheKey]: {
        ...prEntry,
        data: {
          ...prEntry.data,
          checksStatus: nextStatus
        }
      }
    }
  }
}
