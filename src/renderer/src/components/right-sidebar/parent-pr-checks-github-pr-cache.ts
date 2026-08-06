import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { PRInfo, Repo, Worktree } from '../../../../shared/types'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../../shared/execution-host'
import { isCachedMergedBranchPRCurrentForWorktree } from '@/components/sidebar/worktree-card-pr-display'
import type { AppState } from '@/store/types'
import { getGitHubPRCacheKey, getLegacyGitHubPRCacheKey } from '@/store/slices/github-cache-key'
import type { ParentPrChecksCacheEntry } from './parent-pr-checks-row-types'

export function canUseParentPrChecksGitHubPRCacheEntry(
  worktree: Worktree,
  prEntry: ParentPrChecksCacheEntry<PRInfo> | undefined,
  hostedReviewEntry: ParentPrChecksCacheEntry<HostedReviewInfo> | undefined
): prEntry is ParentPrChecksCacheEntry<PRInfo> & {
  data: NonNullable<ParentPrChecksCacheEntry<PRInfo>['data']>
} {
  const pr = prEntry?.data
  if (!pr) {
    return false
  }
  const prFetchedAt = prEntry.fetchedAt
  const hasLinkedGitHubPR = worktree.linkedPR !== null
  if (hasLinkedGitHubPR && pr.number !== worktree.linkedPR) {
    return false
  }
  if (!hasLinkedGitHubPR && hasNonGitHubLinkedReview(worktree)) {
    return false
  }
  const mergedPrMatchesCurrentHead = isCachedMergedBranchPRCurrentForWorktree(pr, worktree)
  if (pr.state === 'merged' && !mergedPrMatchesCurrentHead) {
    return false
  }
  // Why: a newer hosted-review miss should suppress older branch PR cache unless
  // a merged PR is proven to still describe the checked-out worktree head.
  if (
    hostedReviewEntry?.data === null &&
    !mergedPrMatchesCurrentHead &&
    prFetchedAt <= hostedReviewEntry.fetchedAt
  ) {
    return false
  }
  return true
}

export function getParentPrChecksGitHubPRCacheEntry({
  prCache,
  repo,
  branch,
  settings
}: {
  prCache: Record<string, ParentPrChecksCacheEntry<PRInfo>>
  repo: Repo
  branch: string
  settings: AppState['settings']
}): ParentPrChecksCacheEntry<PRInfo> | undefined {
  const currentKey = getGitHubPRCacheKey(
    repo.path,
    repo.id,
    branch,
    settings,
    repo.connectionId,
    repo.executionHostId,
    true
  )
  const executionHostId = normalizeExecutionHostId(repo.executionHostId)
  const canUseLegacyPRCache =
    !repo.connectionId && (!executionHostId || executionHostId === LOCAL_EXECUTION_HOST_ID)
  const legacyRepoKey = canUseLegacyPRCache
    ? getLegacyGitHubPRCacheKey(repo.path, repo.id, branch)
    : ''
  const legacyPathKey = canUseLegacyPRCache
    ? getLegacyGitHubPRCacheKey(repo.path, undefined, branch)
    : ''
  return (
    prCache[currentKey] ??
    (legacyRepoKey ? prCache[legacyRepoKey] : undefined) ??
    (legacyPathKey ? prCache[legacyPathKey] : undefined)
  )
}

function hasNonGitHubLinkedReview(worktree: Worktree): boolean {
  return (
    worktree.linkedGitLabMR != null ||
    worktree.linkedBitbucketPR != null ||
    worktree.linkedAzureDevOpsPR != null ||
    worktree.linkedGiteaPR != null
  )
}
