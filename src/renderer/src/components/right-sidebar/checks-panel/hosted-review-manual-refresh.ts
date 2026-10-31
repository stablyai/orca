import { refreshHostedReviewCard } from '@/store/slices/hosted-review-card-refresh'
import type { ChecksPanelManualRefreshInput } from './manual-refresh-dependencies'

export function checksPanelManualRefreshProvider(model: ChecksPanelManualRefreshInput) {
  return (
    model.activeReview?.provider ??
    (model.isGitLabReviewContext
      ? 'gitlab'
      : model.linkedBitbucketPR != null
        ? 'bitbucket'
        : model.linkedAzureDevOpsPR != null
          ? 'azure-devops'
          : model.linkedGiteaPR != null
            ? 'gitea'
            : 'github')
  )
}

export async function refreshChecksPanelHostedReview(
  model: ChecksPanelManualRefreshInput,
  isCurrentRequest: () => boolean
): Promise<'review' | 'no-review' | 'superseded'> {
  const {
    repo,
    branch,
    fetchHostedReviewForBranch,
    linkedPR,
    fallbackGitHubPRNumber,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR,
    activeGitLabReview,
    fetchGitLabDetails,
    setChecks,
    setComments
  } = model
  if (!repo || !branch) {
    return 'superseded'
  }
  const refreshedReview = await refreshHostedReviewCard(fetchHostedReviewForBranch, {
    repoPath: repo.path,
    repoId: repo.id,
    branch,
    admissionTier: 'interactive',
    userRefresh: true,
    linkedGitHubPR: linkedPR,
    fallbackGitHubPR: fallbackGitHubPRNumber,
    linkedGitLabMR,
    linkedBitbucketPR,
    linkedAzureDevOpsPR,
    linkedGiteaPR
  })
  if (!isCurrentRequest()) {
    return 'superseded'
  }
  if (checksPanelManualRefreshProvider(model) !== 'gitlab') {
    return 'review'
  }
  const refreshedGitLabReview =
    refreshedReview?.provider === 'gitlab' ? refreshedReview : activeGitLabReview
  if (refreshedGitLabReview) {
    await fetchGitLabDetails({
      mrNumberOverride: refreshedGitLabReview.number,
      headShaOverride: refreshedGitLabReview.headSha,
      commitAsCurrent: true,
      isRequestCurrent: isCurrentRequest
    })
    return 'review'
  }
  setChecks([])
  setComments([])
  return 'no-review'
}
