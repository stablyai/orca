import { resolveWorktreeBranchLabel } from '@/lib/worktree-default-display-name'
import { resolvePaletteRepoForWorktree } from '@/lib/palette-repo-resolution'
import { getGitHubPRCacheKey } from '@/store/slices/github-cache-key'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review-cache-identity'
import type { AppState } from '@/store/types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { isGitHubPRSuppressed } from '../../../../shared/worktree/github-pr-suppression'
import { selectChecksPanelReview } from '../right-sidebar/checks-panel-review'

type WorktreeChecksReviewIndexArgs = {
  worktrees: readonly Worktree[]
  repoByHostIdentity: ReadonlyMap<string, Repo>
  prCache: AppState['prCache'] | null
  hostedReviewCache: AppState['hostedReviewCache'] | null
  settings: AppState['settings']
}

const EMPTY_REPO_MAP: ReadonlyMap<string, Repo> = new Map()

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
    const repo = resolvePaletteRepoForWorktree(worktree, EMPTY_REPO_MAP, repoByHostIdentity)
    if (!repo) {
      continue
    }
    // Why: Cmd+J builds this index for every worktree before search runs, so a
    // branch-less folder workspace or partially hydrated row must not throw here.
    const branch = resolveWorktreeBranchLabel(worktree)
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
    const pr = prCache[prKey]?.data
    const review = selectChecksPanelReview({
      hostedReview: hostedReviewCache[hostedReviewKey]?.data,
      pr,
      linkedPR: worktree.linkedPR ?? null,
      suppressedGitHubPR: worktree.suppressedGitHubPR ?? null,
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
      (pr && isGitHubPRSuppressed(worktree, pr.number)) ||
      worktree.linkedGitLabMR != null ||
      worktree.linkedBitbucketPR != null ||
      worktree.linkedAzureDevOpsPR != null ||
      worktree.linkedGiteaPR != null
    ) {
      // Why: an empty Checks selection caused by suppression or a non-GitHub
      // link is authoritative; omission lets Cmd+J fall back to stale GitHub data.
      reviews.set(worktree, null)
    }
  }

  return reviews
}
