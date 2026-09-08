import { reviewHeadKey } from './git-review-push-authority'
import { isPositiveHostedReviewNumber } from './hosted-review'
import type { GitPushTarget, Worktree } from './worktree/types'

export function linkedReviewOperationTarget(
  worktree: Pick<Worktree, 'linkedPR' | 'linkedGitLabMR' | 'pushTarget'> | undefined,
  requested: GitPushTarget | undefined,
  fallbackGitHubPR?: number
): GitPushTarget | undefined {
  if (
    !isPositiveHostedReviewNumber(worktree?.linkedPR) &&
    !isPositiveHostedReviewNumber(worktree?.linkedGitLabMR) &&
    !isPositiveHostedReviewNumber(fallbackGitHubPR) &&
    !worktree?.pushTarget
  ) {
    return requested
  }
  const resolved = worktree?.pushTarget
  if (!resolved?.reviewHead) {
    throw new Error('The linked review push target is still unresolved. Retry after it loads.')
  }
  if (
    requested &&
    (requested.remoteName !== resolved.remoteName ||
      requested.branchName !== resolved.branchName ||
      requested.remoteUrl !== resolved.remoteUrl ||
      reviewHeadKey(requested.reviewHead) !== reviewHeadKey(resolved.reviewHead))
  ) {
    throw new Error('The linked review push target changed. Retry with the current target.')
  }
  return resolved
}
