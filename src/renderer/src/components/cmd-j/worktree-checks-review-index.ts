import { resolveWorktreeBranchLabel } from '@/lib/worktree-default-display-name'
import { resolvePaletteRepoForWorktree } from '@/lib/palette-repo-resolution'
import { getGitHubPRCacheKey } from '../../../../shared/github/github-cache-key'
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
    // Folder workspaces and partially hydrated rows can have no branch even before search starts.
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
    // Reuse Checks’ resolved metadata; search must not start another provider lookup.
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
      // Persisted IDs repeat across hosts; search preserves these object references during sorting/filtering.
      reviews.set(worktree, review)
    } else if (
      (pr && isGitHubPRSuppressed(worktree, pr.number)) ||
      worktree.linkedGitLabMR != null ||
      worktree.linkedBitbucketPR != null ||
      worktree.linkedAzureDevOpsPR != null ||
      worktree.linkedGiteaPR != null
    ) {
      // Suppressed/non-GitHub selections are authoritative; explicit null prevents fallback to stale GitHub data.
      reviews.set(worktree, null)
    }
  }

  return reviews
}
