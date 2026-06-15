import type { AppState } from '../../store/types'
import { getRepoMapFromState, getWorktreeMapFromState } from '../../store/selectors'
import type { CheckStatus } from '../../../../shared/types'
import { getGitHubPRCacheKey } from '../../store/slices/github-cache-key'
import { getHostedReviewCacheKey } from '../../store/slices/hosted-review-cache-identity'

type ActiveChecksStatusState = Pick<
  AppState,
  'activeWorktreeId' | 'worktreesByRepo' | 'repos' | 'prCache'
> &
  Partial<Pick<AppState, 'settings' | 'hostedReviewCache'>>

function branchDisplayName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

export function getActiveChecksStatus(state: ActiveChecksStatusState): CheckStatus | null {
  const activeWorktree = state.activeWorktreeId
    ? (getWorktreeMapFromState(state).get(state.activeWorktreeId) ?? null)
    : null
  if (!activeWorktree) {
    return null
  }

  const activeRepo = getRepoMapFromState(state).get(activeWorktree.repoId)
  if (!activeRepo) {
    return null
  }

  const branch = branchDisplayName(activeWorktree.branch)
  if (!branch) {
    return null
  }

  // Why: PR refreshes are written under repo-id scoped keys so repo path
  // changes and legacy duplicates cannot leave the activity indicator stale.
  const prCacheKey = getGitHubPRCacheKey(
    activeRepo.path,
    activeRepo.id,
    branch,
    state.settings,
    activeRepo.connectionId,
    activeRepo.executionHostId
  )
  const hostedReviewCacheKey = getHostedReviewCacheKey(
    activeRepo.path,
    branch,
    state.settings,
    activeRepo.id,
    activeRepo.connectionId,
    activeRepo.executionHostId
  )
  const hostedReview = state.hostedReviewCache?.[hostedReviewCacheKey]?.data ?? null
  if (hostedReview && hostedReview.provider !== 'github') {
    return hostedReview.status
  }
  if ((activeWorktree.linkedGitLabMR ?? null) !== null) {
    return null
  }
  return state.prCache[prCacheKey]?.data?.checksStatus ?? hostedReview?.status ?? null
}
