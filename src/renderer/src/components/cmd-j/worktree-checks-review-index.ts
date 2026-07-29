import { branchName } from '@/lib/git-utils'
import { getGitHubPRCacheKey } from '@/store/slices/github-cache-key'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import { getRepoHostIdentityForParts } from '@/store/slices/repo-host-identity'
import type { AppState } from '@/store/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { Repo, Worktree } from '../../../../shared/types'
import { selectChecksPanelReview } from '../right-sidebar/checks-panel-review'

type WorktreeChecksReviewIndexArgs = {
  worktrees: readonly Worktree[]
  repoByHostIdentity: ReadonlyMap<string, Repo>
  prCache: AppState['prCache'] | null
  hostedReviewCache: AppState['hostedReviewCache'] | null
  settings: AppState['settings']
}

export function buildWorktreeChecksReviewIndex({
  worktrees,
  repoByHostIdentity,
  prCache,
  hostedReviewCache,
  settings
}: WorktreeChecksReviewIndexArgs): Map<Worktree, HostedReviewInfo | null> {
  const reviews = new Map<Worktree, HostedReviewInfo | null>()
  if (!prCache || !hostedReviewCache) {
    return reviews
  }

  for (const worktree of worktrees) {
    const repo = repoByHostIdentity.get(
      getRepoHostIdentityForParts(worktree.repoId, worktree.hostId ?? LOCAL_EXECUTION_HOST_ID)
    )
    if (!repo) {
      continue
    }
    const branch = branchName(worktree.branch)
    const prKey = getGitHubPRCacheKey(
      repo.path,
      repo.id,
      branch,
      settings,
      repo.connectionId,
      repo.executionHostId,
      true
    )
    const hostedReviewKey = getHostedReviewCacheKey(
      repo.path,
      branch,
      settings,
      repo.id,
      repo.connectionId,
      repo.executionHostId,
      true
    )
    // Why: Cmd+J should expose exactly the review metadata Checks has already
    // resolved, without starting another provider lookup from the search path.
    const review = selectChecksPanelReview({
      hostedReview: hostedReviewCache[hostedReviewKey]?.data,
      pr: prCache[prKey]?.data,
      linkedGitLabMR: worktree.linkedGitLabMR ?? null,
      linkedBitbucketPR: worktree.linkedBitbucketPR ?? null,
      linkedAzureDevOpsPR: worktree.linkedAzureDevOpsPR ?? null,
      linkedGiteaPR: worktree.linkedGiteaPR ?? null
    })
    if (review) {
      // Why: persisted IDs can be identical across execution hosts; the search
      // scope preserves these object references while sorting and filtering.
      reviews.set(worktree, review)
    } else if (
      worktree.linkedGitLabMR != null ||
      worktree.linkedBitbucketPR != null ||
      worktree.linkedAzureDevOpsPR != null ||
      worktree.linkedGiteaPR != null
    ) {
      // Why: an empty Checks selection for a non-GitHub link is authoritative;
      // omitting it would let Cmd+J surface stale GitHub metadata as a fallback.
      reviews.set(worktree, null)
    }
  }

  return reviews
}
