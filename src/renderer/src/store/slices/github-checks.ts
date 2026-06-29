import type { AppState } from '../types'
import type { PRCheckDetail, CheckStatus, GitHubOwnerRepo } from '../../../../shared/types'
import { getGitHubPRCacheKey } from './github-cache-key'

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
  repoId: string | undefined,
  branch: string | undefined,
  checks: PRCheckDetail[],
  headSha?: string,
  prRepo?: GitHubOwnerRepo | null,
  settings?: AppState['settings'],
  connectionId?: string | null,
  executionHostId?: string | null,
  hasRepoOwner = false
): Partial<AppState> | null {
  const normalized = branch ? normalizeBranchName(branch) : ''
  if (!normalized) {
    return null
  }

  const prCacheKey = getGitHubPRCacheKey(
    repoPath,
    repoId,
    normalized,
    settings,
    connectionId,
    executionHostId,
    hasRepoOwner
  )
  const prEntry = state.prCache[prCacheKey]
  if (!prEntry?.data) {
    return null
  }
  // Why: fork PR rediscovery can retarget the branch cache while an older
  // checks request is still in flight; only the matching PR repo may update it.
  if (prRepo !== undefined && !samePRRepo(prEntry.data.prRepo, prRepo)) {
    return null
  }
  if (headSha && prEntry.data.headSha && prEntry.data.headSha !== headSha) {
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

function normalizedPRRepo(repo?: GitHubOwnerRepo | null): string | null {
  if (!repo) {
    return null
  }
  return `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`
}

function samePRRepo(left?: GitHubOwnerRepo | null, right?: GitHubOwnerRepo | null): boolean {
  return normalizedPRRepo(left) === normalizedPRRepo(right)
}
