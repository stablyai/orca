import type { AppState } from '../types'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import { getGitHubPRCacheKey } from './github-cache-key'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { derivePRCheckStatuses, derivePRCheckStatus } from '../../../../shared/pr-check-status'
import { getHostedReviewCacheKey } from './hosted-review-cache-identity'

export function normalizeBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

export const deriveCheckStatusFromChecks = derivePRCheckStatus
export const deriveCheckStatusesFromChecks = derivePRCheckStatuses

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
  hasRepoOwner = false,
  prNumber?: number
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
  const pr = prEntry?.data ?? null
  const nextStatuses = deriveCheckStatusesFromChecks(checks)
  // Why: fork PR rediscovery can retarget the branch cache while an older
  // checks request is still in flight; only the matching PR repo and head may update it.
  const prMatchesRequest =
    pr !== null &&
    (prNumber === undefined || pr.number === prNumber) &&
    (prRepo === undefined || samePRRepo(pr.prRepo, prRepo)) &&
    (!headSha || !pr.headSha || pr.headSha === headSha)
  const prNeedsUpdate =
    prMatchesRequest &&
    pr !== null &&
    (pr.checksStatus !== nextStatuses.status ||
      pr.checksPresentationStatus !== nextStatuses.presentationStatus)
  const hostedReviewCacheKey = getHostedReviewCacheKey(
    repoPath,
    normalized,
    settings,
    repoId,
    connectionId,
    executionHostId,
    hasRepoOwner
  )
  const hostedReviewEntry = state.hostedReviewCache?.[hostedReviewCacheKey]
  const hostedReview = hostedReviewEntry?.data
  const expectedPRNumber = prNumber ?? pr?.number
  const expectedRepository = prRepo ?? pr?.prRepo
  const hostedReviewRepositoryConflicts =
    hostedReview?.githubRepository !== undefined &&
    expectedRepository !== undefined &&
    !samePRRepo(hostedReview.githubRepository, expectedRepository)
  const hostedReviewRepositoryUnverifiable =
    hostedReview?.githubRepository !== undefined && expectedRepository === undefined
  const hostedReviewHeadConflicts =
    headSha !== undefined && hostedReview?.headSha !== undefined && hostedReview.headSha !== headSha
  const hostedReviewNeedsUpdate =
    hostedReview?.provider === 'github' &&
    expectedPRNumber !== undefined &&
    hostedReview.number === expectedPRNumber &&
    !hostedReviewRepositoryConflicts &&
    !hostedReviewRepositoryUnverifiable &&
    !hostedReviewHeadConflicts &&
    (hostedReview.status !== nextStatuses.status ||
      hostedReview.checksPresentationStatus !== nextStatuses.presentationStatus)
  if (!prNeedsUpdate && !hostedReviewNeedsUpdate) {
    return null
  }

  return {
    ...(prNeedsUpdate && prEntry && pr
      ? {
          prCache: {
            ...state.prCache,
            [prCacheKey]: {
              ...prEntry,
              data: {
                ...pr,
                checksStatus: nextStatuses.status,
                checksPresentationStatus: nextStatuses.presentationStatus
              }
            }
          }
        }
      : {}),
    ...(hostedReviewNeedsUpdate && hostedReviewEntry && hostedReview
      ? {
          hostedReviewCache: {
            ...state.hostedReviewCache,
            [hostedReviewCacheKey]: {
              ...hostedReviewEntry,
              data: {
                ...hostedReview,
                status: nextStatuses.status,
                checksPresentationStatus: nextStatuses.presentationStatus
              }
            }
          }
        }
      : {})
  }
}

function normalizedPRRepo(repo?: GitHubOwnerRepo | null): string | null {
  return repo ? githubRepoIdentityKey(repo) : null
}

function samePRRepo(left?: GitHubOwnerRepo | null, right?: GitHubOwnerRepo | null): boolean {
  return normalizedPRRepo(left) === normalizedPRRepo(right)
}
