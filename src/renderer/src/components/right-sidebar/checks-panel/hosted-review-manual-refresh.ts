import { useState } from 'react'
import type { HostedReviewProvider } from '../../../../../shared/hosted-review'
import { useAppStore } from '@/store'
import { refreshHostedReviewCard } from '@/store/slices/hosted-review-card-refresh'
import type { ChecksPanelManualRefreshInput } from './manual-refresh-dependencies'

/** Reviews and links name the provider first; an unlinked branch falls back to the remote's provider, not GitHub. */
export function checksPanelManualRefreshProvider(
  model: ChecksPanelManualRefreshInput
): HostedReviewProvider {
  return (
    model.activeReview?.provider ??
    model.hostedReview?.provider ??
    (model.isGitLabReviewContext
      ? 'gitlab'
      : model.linkedBitbucketPR != null
        ? 'bitbucket'
        : model.linkedAzureDevOpsPR != null
          ? 'azure-devops'
          : model.linkedGiteaPR != null
            ? 'gitea'
            : model.hostedReviewCreateProvider)
  )
}

/** A failed click's message, kept until a click succeeds, the context changes or a newer read lands. */
export function useChecksPanelManualRefreshFailure(
  panelContextKey: string,
  hostedReviewCacheKey: string
) {
  const [failure, setManualFailure] = useState<{
    contextKey: string
    message: string | null
    failedAt: number
  }>({ contextKey: panelContextKey, message: null, failedAt: 0 })
  if (failure.contextKey !== panelContextKey) {
    setManualFailure({ contextKey: panelContextKey, message: null, failedAt: 0 })
  }
  // A read that lands after the failure, from any caller, supersedes it; the data on screen is current again.
  const fetchedAt = useAppStore((s) =>
    hostedReviewCacheKey ? (s.hostedReviewCache[hostedReviewCacheKey]?.fetchedAt ?? 0) : 0
  )
  return {
    manualRefreshError:
      failure.contextKey === panelContextKey && fetchedAt <= failure.failedAt
        ? failure.message
        : null,
    setManualFailure
  }
}

/** The click's own review read: it never joins a read that began before the click. */
export function refreshHostedReviewForClick(
  model: ChecksPanelManualRefreshInput,
  repo: NonNullable<ChecksPanelManualRefreshInput['repo']>,
  branch: string,
  fallbackGitHubPR: number | null
) {
  return refreshHostedReviewCard(model.fetchHostedReviewForBranch, {
    repoPath: repo.path,
    repoId: repo.id,
    branch,
    admissionTier: 'interactive',
    userRefresh: true,
    linkedGitHubPR: model.linkedPR,
    fallbackGitHubPR,
    linkedGitLabMR: model.linkedGitLabMR,
    linkedBitbucketPR: model.linkedBitbucketPR,
    linkedAzureDevOpsPR: model.linkedAzureDevOpsPR,
    linkedGiteaPR: model.linkedGiteaPR
  })
}

export async function refreshChecksPanelHostedReview(
  model: ChecksPanelManualRefreshInput,
  provider: HostedReviewProvider,
  isCurrentRequest: () => boolean
): Promise<'review' | 'no-review' | 'superseded'> {
  const { repo, branch, activeGitLabReview, fetchGitLabDetails, setChecks, setComments } = model
  if (!repo || !branch) {
    return 'superseded'
  }
  const refreshedReview = await refreshHostedReviewForClick(
    model,
    repo,
    branch,
    model.fallbackGitHubPRNumber
  )
  if (!isCurrentRequest()) {
    return 'superseded'
  }
  if (provider !== 'gitlab') {
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
