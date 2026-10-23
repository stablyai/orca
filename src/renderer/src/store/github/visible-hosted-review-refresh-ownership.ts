import type { AppState } from '../types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { GitHubPRRefreshCandidate } from '../../../../shared/github/pull-request-refresh-types'
import { getHostedReviewCacheKey } from '../slices/hosted-review-cache-identity'
import { getGitHubRepoLookupIndex } from '../slices/github-repo-lookup-index'

export function shouldCoordinateVisibleGitHubReview(
  state: AppState,
  worktree: Worktree,
  candidate: GitHubPRRefreshCandidate
): boolean {
  if (hasNonGitHubReview(state, worktree, candidate)) {
    return false
  }
  const key = getHostedReviewCacheKey(
    candidate.repoPath,
    candidate.branch,
    state.settings,
    candidate.repoId,
    candidate.connectionId,
    candidate.executionHostId,
    true
  )
  const hosted = state.hostedReviewCache[key]
  const remote = getGitHubRepoLookupIndex(state.repos).findById(candidate.repoId)?.gitRemoteIdentity
  return (
    state.prCache[candidate.cacheKey]?.data != null ||
    hosted?.data?.provider === 'github' ||
    worktree.linkedPR != null ||
    (hosted?.linkedReviewHintKey?.split('|').some((hint) => hint.startsWith('github:')) ?? false) ||
    remote?.canonicalKey.split('/', 1)[0].toLowerCase() === 'github.com'
  )
}

export function hasNonGitHubReview(
  state: AppState,
  worktree: Worktree,
  candidate: GitHubPRRefreshCandidate
): boolean {
  if (
    worktree.linkedGitLabMR != null ||
    worktree.linkedBitbucketPR != null ||
    worktree.linkedAzureDevOpsPR != null ||
    worktree.linkedGiteaPR != null
  ) {
    return true
  }
  const key = getHostedReviewCacheKey(
    candidate.repoPath,
    candidate.branch,
    state.settings,
    candidate.repoId,
    candidate.connectionId,
    candidate.executionHostId,
    true
  )
  const hosted = state.hostedReviewCache[key]
  return hosted?.data != null && hosted.data.provider !== 'github'
}
