import { useCallback } from 'react'
import { refreshHostedReviewCard } from '@/store/slices/hosted-review-card-refresh'
import { resolveCreatedHostedReviewLink } from '../source-control-created-review-link'
import type { HostedReviewProvider } from '../../../../../shared/hosted-review'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import type { ChecksPanelPollingState } from './use-checks-panel-polling'
import type { ChecksPanelCheckAndReviewActionsState } from './use-checks-panel-check-and-review-actions'
import { createdReviewIsForeground } from '../created-review-foreground'

export type ChecksPanelCreatedReviewInput = Pick<
  ChecksPanelControllerState,
  | 'activeWorktreeId'
  | 'branch'
  | 'fetchHostedReviewForBranch'
  | 'repo'
  | 'setRightSidebarOpen'
  | 'setRightSidebarTab'
  | 'updateWorktreeMeta'
> &
  Pick<
    ChecksPanelContextState,
    | 'fallbackGitHubPRNumber'
    | 'linkedAzureDevOpsPR'
    | 'linkedBitbucketPR'
    | 'linkedGiteaPR'
    | 'linkedGitLabMR'
    | 'linkedPR'
  > &
  Pick<ChecksPanelPollingState, 'fetchGitLabDetails'> &
  Pick<ChecksPanelCheckAndReviewActionsState, 'refreshLinkedGitHubPullRequest'>

/** Links a review created from the Checks panel to its worktree and refreshes what shows it. */
export function useChecksPanelCreatedReview(model: ChecksPanelCreatedReviewInput) {
  const {
    activeWorktreeId,
    branch,
    fallbackGitHubPRNumber,
    fetchGitLabDetails,
    fetchHostedReviewForBranch,
    linkedAzureDevOpsPR,
    linkedBitbucketPR,
    linkedGiteaPR,
    linkedGitLabMR,
    linkedPR,
    refreshLinkedGitHubPullRequest,
    repo,
    setRightSidebarOpen,
    setRightSidebarTab,
    updateWorktreeMeta
  } = model
  return useCallback(
    async (
      result: {
        provider: HostedReviewProvider
        number: number
        url: string
      },
      // Why: a create that outlives its panel context still links its worktree, but must not paint into the panel's new context.
      panelShowsReview: boolean
    ): Promise<void> => {
      if (!repo || !branch) {
        return
      }
      if (createdReviewIsForeground(activeWorktreeId, panelShowsReview)) {
        setRightSidebarOpen(true)
        setRightSidebarTab('checks')
      }
      try {
        const createdLink = resolveCreatedHostedReviewLink(result.provider, result.number)
        if (activeWorktreeId && result.provider !== 'unsupported') {
          await updateWorktreeMeta(activeWorktreeId, createdLink.worktree)
        }
        const linkedReviewNumbers = {
          linkedGitHubPR: linkedPR,
          fallbackGitHubPR: fallbackGitHubPRNumber,
          linkedGitLabMR,
          linkedBitbucketPR,
          linkedAzureDevOpsPR,
          linkedGiteaPR,
          ...createdLink.lookup
        }
        if (result.provider === 'gitlab') {
          const refreshedReview = await refreshHostedReviewCard(fetchHostedReviewForBranch, {
            repoPath: repo.path,
            repoId: repo.id,
            branch,
            ...linkedReviewNumbers
          })
          if (!panelShowsReview) {
            return
          }
          const refreshedGitLabReview =
            refreshedReview?.provider === 'gitlab' ? refreshedReview : null
          await fetchGitLabDetails({
            mrNumberOverride: result.number,
            headShaOverride: refreshedGitLabReview?.headSha,
            commitAsCurrent: true
          })
          return
        }
        if (result.provider !== 'github') {
          await refreshHostedReviewCard(fetchHostedReviewForBranch, {
            repoPath: repo.path,
            repoId: repo.id,
            branch,
            ...linkedReviewNumbers
          })
          return
        }
        await refreshLinkedGitHubPullRequest(result.number)
      } catch {
        // The success toast keeps the hosted URL available; Checks can be refreshed manually.
      }
    },
    [
      activeWorktreeId,
      branch,
      fallbackGitHubPRNumber,
      fetchGitLabDetails,
      fetchHostedReviewForBranch,
      linkedAzureDevOpsPR,
      linkedBitbucketPR,
      linkedGiteaPR,
      linkedGitLabMR,
      linkedPR,
      refreshLinkedGitHubPullRequest,
      repo,
      setRightSidebarOpen,
      setRightSidebarTab,
      updateWorktreeMeta
    ]
  )
}
