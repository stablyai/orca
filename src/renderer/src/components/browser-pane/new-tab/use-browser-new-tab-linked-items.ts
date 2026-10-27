import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { useWorktreeCardFoundation } from '../../sidebar/use-worktree-card-foundation'
import { useWorktreeCardReviewDetails } from '../../sidebar/use-worktree-card-review-details'
import { useWorktreeCardLinkedDetails } from '../../sidebar/use-worktree-card-linked-details'
import { useWorktreeCardLifecycleEffects } from '../../sidebar/use-worktree-card-lifecycle-effects'
import {
  getWorkspaceLinkedItemRows,
  type WorkspaceLinkedItemRow
} from '../../sidebar/workspace-hover-attachments'

export function useBrowserNewTabLinkedItems(
  worktree: Worktree,
  repo: Repo | undefined
): WorkspaceLinkedItemRow[] {
  const foundation = useWorktreeCardFoundation({ worktree, repo })
  const review = useWorktreeCardReviewDetails({
    worktree,
    repo,
    settings: foundation.settings,
    projectGroups: foundation.projectGroups,
    cardProps: foundation.cardProps,
    newCardStyle: foundation.newCardStyle
  })
  const linked = useWorktreeCardLinkedDetails({
    worktree,
    newCardStyle: foundation.newCardStyle,
    deleteState: foundation.deleteState,
    branch: review.branch,
    issueEntry: review.issueEntry,
    linearIssueEntry: review.linearIssueEntry,
    linearIssueFallbackEntry: review.linearIssueFallbackEntry,
    prDisplay: review.prDisplay
  })
  // Why details open: the page shows titles and states up front, as the card's hover does.
  useWorktreeCardLifecycleEffects({
    worktree,
    repo,
    isFolder: review.isFolder,
    hostedReviewCacheKey: review.hostedReviewCacheKey,
    cachedBranchFallbackGitHubPRNumber: review.cachedBranchFallbackGitHubPRNumber,
    linkedGitLabMR: review.linkedGitLabMR,
    linkedBitbucketPR: review.linkedBitbucketPR,
    linkedAzureDevOpsPR: review.linkedAzureDevOpsPR,
    linkedGiteaPR: review.linkedGiteaPR,
    branch: review.branch,
    fetchHostedReviewForBranch: foundation.fetchHostedReviewForBranch,
    shouldRefreshHostedReview: false,
    newCardStyle: true,
    hoverDetailsOpen: true,
    showIssue: true,
    issueCacheKey: review.issueCacheKey,
    fetchIssue: foundation.fetchIssue,
    showLinearIssue: true,
    fetchLinearIssue: foundation.fetchLinearIssue,
    linearSourceContext: review.linearSourceContext,
    linearWorkspaceId: review.linearWorkspaceId
  })
  const rows = getWorkspaceLinkedItemRows(
    worktree,
    {
      review: review.prDisplay,
      issue: linked.issueDisplay,
      linearIssue: linked.linearIssue,
      jiraIssue: linked.jiraIssueDisplay
    },
    // Why no per-item details: their lookup routes by the focused server, which this page must not.
    undefined
  )
  // Why: the card also shows the review found from the branch, which no saved link may name.
  const branchReview = review.prDisplay
  if (
    !branchReview?.url ||
    branchReview.provider === 'unsupported' ||
    rows.some(
      (row) =>
        row.item.type !== 'issue' &&
        row.item.provider === branchReview.provider &&
        row.item.number === branchReview.number
    )
  ) {
    return rows
  }
  const branchRow: WorkspaceLinkedItemRow = {
    item: {
      provider: branchReview.provider,
      type: branchReview.provider === 'gitlab' ? 'mr' : 'pr',
      number: branchReview.number,
      title: branchReview.title,
      url: branchReview.url
    },
    key: `branch-review:${branchReview.provider}:${branchReview.number}`,
    url: branchReview.url,
    detail: undefined,
    live: branchReview,
    liveTask: null
  }
  return [branchRow, ...rows]
}
