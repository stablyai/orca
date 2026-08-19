import { useEffect } from 'react'
import type { SourceControlStoreActions } from '../listing/use-store-actions'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlLinkedReviews } from './use-linked-reviews'

/**
 * Keeps the hosted review for the visible branch fresh: resolves the review's push target when the
 * worktree has none, then refetches the review (and the paced GitHub cache) on branch changes.
 */
export function useSourceControlHostedReviewPolling({
  activeRepo,
  activeWorktree,
  activeWorktreeId,
  branchName,
  enqueueGitHubPRRefresh,
  ensureHostedReviewPushTarget,
  fallbackGitHubPRNumber,
  fetchHostedReviewForBranch,
  hasResolvableReviewPushTargetLink,
  isBranchVisible,
  isFolder,
  linkedAzureDevOpsPR,
  linkedBitbucketPR,
  linkedGitHubPR,
  linkedGitLabMR,
  linkedGiteaPR
}: {
  activeRepo: SourceControlWorktreeContext['activeRepo']
  activeWorktree: SourceControlWorktreeContext['activeWorktree']
  activeWorktreeId: string | null
  branchName: string
  enqueueGitHubPRRefresh: SourceControlStoreActions['enqueueGitHubPRRefresh']
  ensureHostedReviewPushTarget: SourceControlStoreActions['ensureHostedReviewPushTarget']
  fallbackGitHubPRNumber: SourceControlLinkedReviews['fallbackGitHubPRNumber']
  fetchHostedReviewForBranch: SourceControlStoreActions['fetchHostedReviewForBranch']
  hasResolvableReviewPushTargetLink: boolean
  isBranchVisible: boolean
  isFolder: boolean
  linkedAzureDevOpsPR: SourceControlLinkedReviews['linkedAzureDevOpsPR']
  linkedBitbucketPR: SourceControlLinkedReviews['linkedBitbucketPR']
  linkedGitHubPR: SourceControlLinkedReviews['linkedGitHubPR']
  linkedGitLabMR: SourceControlLinkedReviews['linkedGitLabMR']
  linkedGiteaPR: SourceControlLinkedReviews['linkedGiteaPR']
}): void {
  useEffect(() => {
    // Why: resolving review heads can hit provider/SSH APIs; gate on the visible branch view like the adjacent PR polling.
    if (!isBranchVisible || isFolder || !activeWorktreeId || activeWorktree?.pushTarget) {
      return
    }
    if (!hasResolvableReviewPushTargetLink) {
      return
    }
    void ensureHostedReviewPushTarget(activeWorktreeId)
  }, [
    activeWorktree?.pushTarget,
    activeWorktreeId,
    ensureHostedReviewPushTarget,
    hasResolvableReviewPushTargetLink,
    isBranchVisible,
    isFolder
  ])

  useEffect(() => {
    if (
      !isBranchVisible ||
      !activeRepo ||
      isFolder ||
      !branchName ||
      branchName === 'HEAD' ||
      !activeWorktreeId
    ) {
      return
    }
    // Why: fetch review immediately on branch change; carry a known PR number because branch lookup is lossy for fork/deleted-head PRs.
    void fetchHostedReviewForBranch(activeRepo.path, branchName, {
      repoId: activeRepo.id,
      linkedGitHubPR,
      fallbackGitHubPR: fallbackGitHubPRNumber,
      linkedGitLabMR,
      linkedBitbucketPR,
      linkedAzureDevOpsPR,
      linkedGiteaPR,
      staleWhileRevalidate: true,
      // Why: scoped to the active worktree, so it earns the host's fast
      // re-check tier instead of the O(N) card pacing (#11532).
      active: true
    })
    // Why: keep the GitHub cache refresh behind the coordinator so Source Control doesn't bypass pacing.
    enqueueGitHubPRRefresh(activeWorktreeId, 'swr', 30)
  }, [
    activeRepo,
    activeWorktreeId,
    branchName,
    enqueueGitHubPRRefresh,
    fetchHostedReviewForBranch,
    isBranchVisible,
    isFolder,
    linkedGitHubPR,
    fallbackGitHubPRNumber,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR
  ])
}
