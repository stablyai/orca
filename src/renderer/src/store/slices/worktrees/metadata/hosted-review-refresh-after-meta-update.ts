import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import type { WorktreeSliceGet } from '../listing/worktree-slice-types'
import type { findKnownWorktreeById } from '../listing/detected-worktree-meta'
import { getHostedReviewLinkForMetaRefresh } from './hosted-review-link-mutation'

type RefreshArgs = {
  suppress: boolean
  reviewRepo: Repo | undefined
  reviewBranch: string | undefined
  repoOwnerExecutionHostId: ExecutionHostId | undefined
  worktreeForUpdate: ReturnType<typeof findKnownWorktreeById>
  targetEnriched: Partial<WorktreeMeta>
}

/**
 * After a review-link change persists, refetch the hosted review against the post-update links
 * so a cache entry from the previous provider link cannot keep showing the removed review.
 */
export function refreshHostedReviewAfterMetaUpdate(
  get: WorktreeSliceGet,
  {
    suppress,
    reviewRepo,
    reviewBranch,
    repoOwnerExecutionHostId,
    worktreeForUpdate,
    targetEnriched
  }: RefreshArgs
): void {
  if (
    suppress ||
    !reviewRepo ||
    !reviewBranch ||
    typeof get().fetchHostedReviewForBranch !== 'function'
  ) {
    return
  }
  void get().fetchHostedReviewForBranch(reviewRepo.path, reviewBranch, {
    repoId: reviewRepo.id,
    repoOwnerExecutionHostId,
    linkedGitHubPR: getHostedReviewLinkForMetaRefresh(
      targetEnriched,
      worktreeForUpdate,
      'linkedPR'
    ),
    linkedGitLabMR: getHostedReviewLinkForMetaRefresh(
      targetEnriched,
      worktreeForUpdate,
      'linkedGitLabMR'
    ),
    linkedBitbucketPR: getHostedReviewLinkForMetaRefresh(
      targetEnriched,
      worktreeForUpdate,
      'linkedBitbucketPR'
    ),
    linkedAzureDevOpsPR: getHostedReviewLinkForMetaRefresh(
      targetEnriched,
      worktreeForUpdate,
      'linkedAzureDevOpsPR'
    ),
    linkedGiteaPR: getHostedReviewLinkForMetaRefresh(
      targetEnriched,
      worktreeForUpdate,
      'linkedGiteaPR'
    ),
    force: true
  })
}
