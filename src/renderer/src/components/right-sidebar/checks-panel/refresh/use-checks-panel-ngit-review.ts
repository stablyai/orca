import { useEffect } from 'react'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { useChecksPanelContextState } from '../review-state/use-checks-panel-context-state'
import type { useChecksPanelControllerState } from '../panel/use-checks-panel-controller-state'
import type { useChecksPanelReviewState } from '../review-state/use-checks-panel-review-state'

type NgitReviewInput = ReturnType<typeof useChecksPanelControllerState> &
  ReturnType<typeof useChecksPanelContextState> &
  ReturnType<typeof useChecksPanelReviewState>

/** The panel's own refreshes read only GitHub and GitLab reviews, so an ngit one is asked for here. */
export function useChecksPanelNgitReview({
  repo,
  branch,
  activeWorktree,
  isPanelVisible,
  hostedReview,
  hostedReviewCreation,
  fetchHostedReviewForBranch
}: NgitReviewInput): void {
  const wanted = isPanelVisible && hostedReviewCreation?.provider === 'ngit' && !hostedReview
  const head = activeWorktree?.head ?? null
  const reviewUrl = hostedReviewCreation?.review?.url
  useEffect(() => {
    if (!wanted || !repo || !branch) {
      return
    }
    void fetchHostedReviewForBranch(repo.path, branch, {
      force: true,
      repoId: repo.id,
      repoOwnerExecutionHostId: getRepoExecutionHostId(repo),
      currentHeadOid: head
    })
  }, [wanted, repo, branch, head, reviewUrl, fetchHostedReviewForBranch])
}
