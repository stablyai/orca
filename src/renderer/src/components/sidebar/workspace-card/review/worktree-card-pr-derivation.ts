import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { AppState } from '@/store/types'
import { getGitHubPRCacheKey } from '../../../../../../shared/github/cache/github-cache-key'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review/hosted-review-cache-identity'
import { hostedReviewInfoFromGitHubPRInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-github'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { getWorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/row-display/git-identity-display'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { getDetachedWorkspaceReviewRequest } from './workspace-detached-review-request'
import {
  getWorktreeCardPrDisplay,
  isCachedMergedBranchPRCurrentForWorktree,
  type WorktreeCardPrDisplay
} from './worktree-card-pr-display'

type HostedReviewEntry = AppState['hostedReviewCache'][string]
type PrCacheEntry = NonNullable<AppState['prCache']>[string]

/** The cache entries a worktree's review is read from; subscribe to only these. */
export function getWorktreeReviewCacheKeys(
  worktree: Worktree,
  repo: Repo | undefined,
  settings: GlobalSettings | null | undefined
): { branch: string; hostedReviewCacheKey: string; prCacheKey: string } {
  const gitIdentityDisplay = getWorktreeGitIdentityDisplay(worktree)
  const branch = gitIdentityDisplay?.kind === 'branch' ? gitIdentityDisplay.branchName : ''
  const hostedReviewCacheKey =
    getDetachedWorkspaceReviewRequest(worktree, repo)?.key ??
    (repo && branch
      ? getHostedReviewCacheKey(
          repo.path,
          branch,
          settings,
          repo.id,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : '')
  const prCacheKey =
    repo && branch
      ? getGitHubPRCacheKey(
          repo.path,
          repo.id,
          branch,
          settings,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  return { branch, hostedReviewCacheKey, prCacheKey }
}

/** The review a card shows, from its cache entries and linked review numbers. */
export function deriveWorktreeCardPrDisplay(
  worktree: Worktree,
  hostedReviewEntry: HostedReviewEntry | undefined,
  prCacheEntry: PrCacheEntry | undefined,
  t: Translate = translate
): { prDisplay: WorktreeCardPrDisplay | null; cachedBranchFallbackGitHubPRNumber: number | null } {
  const hostedReview: HostedReviewInfo | null | undefined =
    hostedReviewEntry !== undefined ? hostedReviewEntry.data : undefined
  const linkedGitHubPR = worktree.linkedPR ?? null
  const linkedGitLabMR = worktree.linkedGitLabMR ?? null
  const linkedBitbucketPR = worktree.linkedBitbucketPR ?? null
  const linkedAzureDevOpsPR = worktree.linkedAzureDevOpsPR ?? null
  const linkedGiteaPR = worktree.linkedGiteaPR ?? null
  const hasNonGitHubLinkedReview =
    linkedGitLabMR !== null ||
    linkedBitbucketPR !== null ||
    linkedAzureDevOpsPR !== null ||
    linkedGiteaPR !== null
  const hasLinkedReview = linkedGitHubPR !== null || hasNonGitHubLinkedReview
  // Why: a newer hosted-review miss trusts the merged-PR cache only when the stored head proves it still describes the current commit.
  const cachedBranchPR = prCacheEntry?.data
  const cachedBranchPRFetchedAt = prCacheEntry?.fetchedAt
  const cachedMergedBranchPRMatchesCurrentHead = isCachedMergedBranchPRCurrentForWorktree(
    cachedBranchPR,
    worktree
  )
  const cachedBranchFallbackGitHubPRNumber =
    linkedGitHubPR === null &&
    !hasNonGitHubLinkedReview &&
    cachedBranchPR?.number !== undefined &&
    (cachedBranchPR.state !== 'merged' || cachedMergedBranchPRMatchesCurrentHead)
      ? cachedBranchPR.number
      : null
  const cachedBranchPRCanDriveDisplay =
    cachedBranchPR?.state !== 'merged' || cachedMergedBranchPRMatchesCurrentHead
  const hostedReviewMatchesHeadMatchedCachedMergedPR =
    cachedMergedBranchPRMatchesCurrentHead &&
    cachedBranchPR !== null &&
    cachedBranchPR !== undefined &&
    hostedReview?.provider === 'github' &&
    hostedReview.number === cachedBranchPR.number
  const useCachedBranchReview =
    cachedBranchPR !== undefined &&
    cachedBranchPR !== null &&
    !hasNonGitHubLinkedReview &&
    cachedBranchPRCanDriveDisplay &&
    (hostedReview === undefined ||
      (cachedMergedBranchPRMatchesCurrentHead && !hostedReviewMatchesHeadMatchedCachedMergedPR) ||
      (hostedReview === null &&
        ((cachedBranchPRFetchedAt !== undefined &&
          cachedBranchPRFetchedAt > (hostedReviewEntry?.fetchedAt ?? 0)) ||
          cachedMergedBranchPRMatchesCurrentHead)))
  const staleUnlinkedMergedReview =
    !hasLinkedReview &&
    hostedReview?.provider === 'github' &&
    hostedReview.state === 'merged' &&
    !isCachedMergedBranchPRCurrentForWorktree(hostedReview, worktree)
  const cachedBranchReview = useCachedBranchReview
    ? hostedReviewInfoFromGitHubPRInfo(cachedBranchPR)
    : staleUnlinkedMergedReview
      ? null
      : hostedReview
  // Why: branch provenance does not supersede the head-ownership gate for merged PRs.
  const branchLookupGitHubPRNumber =
    hostedReview?.provider === 'github' &&
    hostedReview.state === 'merged' &&
    !isCachedMergedBranchPRCurrentForWorktree(hostedReview, worktree)
      ? null
      : hostedReviewEntry?.branchLookupGitHubPRNumber
  const prDisplay = getWorktreeCardPrDisplay(
    cachedBranchReview,
    linkedGitHubPR,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    {
      reviewHintKey:
        (useCachedBranchReview || cachedMergedBranchPRMatchesCurrentHead) && !hasLinkedReview
          ? ''
          : hostedReviewEntry?.linkedReviewHintKey,
      branchLookupGitHubPRNumber,
      suppressedGitHubPR: worktree.suppressedGitHubPR ?? null
    },
    t
  )
  return { prDisplay, cachedBranchFallbackGitHubPRNumber }
}
