import { getHostedReviewCacheKey } from '../../slices/hosted-review/hosted-review-cache-identity'
import type { AppState } from '../../types'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import {
  getGitHubPRCacheKey,
  type RuntimeFocusSettings
} from '../../../../../shared/github/github-cache-key'
import { githubRepoIdentityKey } from '../../../../../shared/github/repository-identity-key'
import { derivePRCheckStatus } from '../../../../../shared/source-control/checks/pr-check-status'

export function normalizeBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

export function syncPRChecksStatus(
  state: AppState,
  repoPath: string,
  repoId: string | undefined,
  branch: string | undefined,
  checks: PRCheckDetail[],
  headSha?: string,
  prRepo?: GitHubOwnerRepo | null,
  settings?: RuntimeFocusSettings,
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
  // Fork rediscovery can retarget branch cache mid-check request; update only matching PR repo identity.
  if (prRepo !== undefined && !samePRRepo(prEntry.data.prRepo, prRepo)) {
    return null
  }
  if (headSha && prEntry.data.headSha && prEntry.data.headSha !== headSha) {
    return null
  }

  const nextStatus = derivePRCheckStatus(checks)
  // Detail pages are partial; retain the complete same-head summary until the next PR lookup.
  if (prEntry.data.checksStatus === nextStatus) {
    return null
  }

  const hostedKey = getHostedReviewCacheKey(
    repoPath,
    normalized,
    settings,
    repoId,
    connectionId,
    executionHostId,
    hasRepoOwner
  )
  const hostedEntry = state.hostedReviewCache?.[hostedKey]
  const hosted = hostedEntry?.data
  return {
    ...(hosted?.provider === 'github' &&
    hosted.number === prEntry.data.number &&
    hosted.headSha === prEntry.data.headSha &&
    samePRRepo(hosted.githubRepository, prEntry.data.prRepo)
      ? {
          hostedReviewCache: {
            ...state.hostedReviewCache,
            [hostedKey]: {
              ...hostedEntry,
              data: { ...hosted, status: nextStatus, checksSummary: undefined }
            }
          }
        }
      : {}),
    prCache: {
      ...state.prCache,
      [prCacheKey]: {
        ...prEntry,
        data: {
          ...prEntry.data,
          checksStatus: nextStatus,
          checksSummary: undefined
        }
      }
    }
  }
}

function normalizedPRRepo(repo?: GitHubOwnerRepo | null): string | null {
  return repo ? githubRepoIdentityKey(repo) : null
}

function samePRRepo(left?: GitHubOwnerRepo | null, right?: GitHubOwnerRepo | null): boolean {
  return normalizedPRRepo(left) === normalizedPRRepo(right)
}
