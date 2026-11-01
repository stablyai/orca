import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { setGitHubPRResultCaches } from '@/store/github/pr-result-cache'
import { isPositiveHostedReviewNumber } from '../../../../../shared/hosted-review'
import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelReviewState } from './use-checks-panel-review-state'

type ChecksPanelGitHubReviewHydrationInput = Pick<
  ChecksPanelContextState,
  | 'hostedReview'
  | 'hostedReviewCacheKey'
  | 'isFolder'
  | 'linkedAzureDevOpsPR'
  | 'linkedBitbucketPR'
  | 'linkedGiteaPR'
  | 'linkedGitLabMR'
  | 'linkedPR'
  | 'pr'
  | 'prCacheKey'
  | 'prRefreshState'
> &
  Pick<
    ChecksPanelControllerState,
    | 'activeWorktreeId'
    | 'branch'
    | 'fetchPRForBranch'
    | 'hostedReviewCreationSnapshot'
    | 'isPanelVisible'
    | 'repo'
  > &
  Pick<ChecksPanelReviewState, 'hostedReviewCreation'>

export function useChecksPanelGitHubReviewHydration({
  activeWorktreeId,
  branch,
  fetchPRForBranch,
  hostedReview,
  hostedReviewCacheKey,
  hostedReviewCreation,
  hostedReviewCreationSnapshot,
  isFolder,
  isPanelVisible,
  linkedAzureDevOpsPR,
  linkedBitbucketPR,
  linkedGiteaPR,
  linkedGitLabMR,
  linkedPR,
  pr,
  prCacheKey,
  prRefreshState,
  repo
}: ChecksPanelGitHubReviewHydrationInput) {
  const knownGitHubPRNumber =
    linkedPR ??
    (hostedReviewCreation?.provider === 'github' ? hostedReviewCreation.review?.number : null) ??
    (hostedReview?.provider === 'github' ? hostedReview.number : null)
  const hydrationContextKey =
    isPanelVisible && repo && !isFolder && branch ? `${activeWorktreeId ?? ''}::${prCacheKey}` : ''
  const hydrationAttemptRef = useRef<{ contextKey: string; number: number } | null>(null)
  useEffect(() => {
    if (hydrationAttemptRef.current?.contextKey !== hydrationContextKey || pr) {
      hydrationAttemptRef.current = null
    }
    if (
      !hydrationContextKey ||
      !repo ||
      pr ||
      (!hostedReviewCreation && !hostedReview) ||
      linkedGitLabMR != null ||
      linkedBitbucketPR != null ||
      linkedAzureDevOpsPR != null ||
      linkedGiteaPR != null ||
      !isPositiveHostedReviewNumber(knownGitHubPRNumber) ||
      knownGitHubPRNumber == null
    ) {
      return
    }
    const hostedEntry = useAppStore.getState().hostedReviewCache[hostedReviewCacheKey]
    const eligibilityDetails = hostedReviewCreation?.githubPullRequest
    const hostedDetails =
      hostedReview?.provider === 'github' ? hostedReview.githubPullRequest : null
    const eligibilityFetchedAt = hostedReviewCreationSnapshot?.completedAt ?? 0
    const useEligibilityDetails =
      eligibilityDetails && eligibilityFetchedAt >= (hostedEntry?.fetchedAt ?? 0)
    const details = useEligibilityDetails ? eligibilityDetails : hostedDetails
    const fetchedAt = useEligibilityDetails ? eligibilityFetchedAt : (hostedEntry?.fetchedAt ?? 0)
    if (
      details &&
      details.number === knownGitHubPRNumber &&
      details.url ===
        (useEligibilityDetails ? hostedReviewCreation?.review?.url : hostedReview?.url)
    ) {
      hydrationAttemptRef.current = { contextKey: hydrationContextKey, number: knownGitHubPRNumber }
      useAppStore.setState((state) => {
        if (
          state.prCache[prCacheKey]?.data ||
          (state.prCache[prCacheKey]?.fetchedAt ?? 0) > fetchedAt
        ) {
          return state
        }
        return setGitHubPRResultCaches(state, {
          prCacheKey,
          repoPath: repo.path,
          repoId: repo.id,
          branch,
          settings: state.settings,
          connectionId: repo.connectionId,
          executionHostId: repo.executionHostId,
          hasRepoOwner: true,
          pr: details,
          fetchedAt,
          linkedPRNumber: linkedPR,
          fallbackPRNumber: linkedPR == null ? knownGitHubPRNumber : null
        })
      })
      return
    }
    if (
      hydrationAttemptRef.current?.number === knownGitHubPRNumber ||
      (prRefreshState &&
        !(prRefreshState.status === 'skipped' && prRefreshState.skippedReason === 'fresh'))
    ) {
      return
    }
    hydrationAttemptRef.current = { contextKey: hydrationContextKey, number: knownGitHubPRNumber }
    // A positive lookup must hydrate the checks panel even when a separate branch read cached a miss.
    void fetchPRForBranch(repo.path, branch, {
      force: true,
      repoId: repo.id,
      worktreeId: activeWorktreeId ?? undefined,
      linkedPRNumber: linkedPR,
      fallbackPRNumber: linkedPR == null ? knownGitHubPRNumber : null,
      reason: 'active'
    }).catch(() => {})
  }, [
    hydrationContextKey,
    knownGitHubPRNumber,
    repo,
    branch,
    activeWorktreeId,
    pr,
    prRefreshState,
    prCacheKey,
    hostedReview,
    hostedReviewCacheKey,
    hostedReviewCreation,
    hostedReviewCreationSnapshot,
    linkedPR,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    fetchPRForBranch
  ])
}
