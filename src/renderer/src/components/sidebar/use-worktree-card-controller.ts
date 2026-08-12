import { canShowWorkspaceDeleteQuickAction } from './workspace-delete-quick-action'
import { useWorktreeCardDetailsHoverControl } from './worktree-card-details-hover-state'
import type { ResolvedWorktreeCardProps } from './worktree-card-model'
import { useWorktreeCardActivationActions } from './use-worktree-card-activation-actions'
import { useWorktreeCardFoundation } from './use-worktree-card-foundation'
import { useWorktreeCardLifecycleEffects } from './use-worktree-card-lifecycle-effects'
import { useWorktreeCardLinkedDetails } from './use-worktree-card-linked-details'
import { useWorktreeCardReviewDetails } from './use-worktree-card-review-details'
import { useWorktreeCardSecondaryDetails } from './use-worktree-card-secondary-details'
import { useWorktreeCardWorkspaceActions } from './use-worktree-card-workspace-actions'

export function useWorktreeCardController(props: ResolvedWorktreeCardProps) {
  const { worktree, repo } = props
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

  const showStatus = foundation.cardProps.includes('status')
  const showIssue = foundation.cardProps.includes('issue')
  const showLinearIssue = foundation.cardProps.includes('linear-issue')
  const showJiraIssue = foundation.cardProps.includes('jira-issue')
  const showPR = foundation.cardProps.includes('pr')
  const showAutomation = foundation.cardProps.includes('automation')
  const showCli = foundation.cardProps.includes('cli')
  const showComment = foundation.cardProps.includes('comment')
  const showPorts = foundation.cardProps.includes('ports')
  const shouldRefreshHostedReview = foundation.newCardStyle ? showStatus : showPR
  const detailsHoverControl = useWorktreeCardDetailsHoverControl()
  const hoverDetailsOpen = detailsHoverControl.hoverOpen

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
    shouldRefreshHostedReview,
    newCardStyle: foundation.newCardStyle,
    hoverDetailsOpen,
    showIssue,
    issueCacheKey: review.issueCacheKey,
    fetchIssue: foundation.fetchIssue,
    showLinearIssue,
    fetchLinearIssue: foundation.fetchLinearIssue
  })

  const activation = useWorktreeCardActivationActions({
    worktree,
    repo,
    affiliateListMode: props.affiliateListMode,
    onSelectionGesture: props.onSelectionGesture,
    isActive: props.isActive,
    activationRowKey: props.activationRowKey,
    onActivate: props.onActivate,
    onImmediateActivate: props.onImmediateActivate,
    isDeleting: linked.isDeleting,
    isSshDisconnected: foundation.isSshDisconnected,
    updateWorktreeMeta: foundation.updateWorktreeMeta,
    openModal: foundation.openModal
  })

  // Why: delete is destructive, so it only appears while holding Option/Alt, not in the ordinary hover chrome.
  const showDeleteQuickAction =
    !props.affiliateListMode &&
    canShowWorkspaceDeleteQuickAction({
      deleteModifierPressed: linked.deleteModifierPressed,
      isDeleting: linked.isDeleting,
      isMainWorktree: worktree.isMainWorktree
    })
  const workspaceActions = useWorktreeCardWorkspaceActions({
    worktree,
    lineageChildCount: props.lineageChildCount,
    lineageCollapsed: props.lineageCollapsed,
    onLineageToggle: props.onLineageToggle,
    isMultiSelected: props.isMultiSelected,
    selectedWorktrees: props.selectedWorktrees,
    onCardDragStart: props.onCardDragStart,
    onCardDragEnd: props.onCardDragEnd,
    onContextMenuSelect: props.onContextMenuSelect,
    folderWorkspaceId: review.folderWorkspaceId,
    deleteFolderWorkspace: foundation.deleteFolderWorkspace,
    setActiveWorktree: foundation.setActiveWorktree,
    setShowRenameErrorDialog: foundation.setShowRenameErrorDialog,
    isDeleting: linked.isDeleting,
    showDeleteQuickAction
  })

  const secondary = useWorktreeCardSecondaryDetails({
    worktree,
    repo,
    statusPrDisplay: props.statusPrDisplay,
    showStatus,
    showIssue,
    showLinearIssue,
    showJiraIssue,
    showPR,
    showAutomation,
    showCli,
    showComment,
    showPorts,
    issueDisplay: linked.issueDisplay,
    linearIssue: linked.linearIssue,
    linearIssueDisplay: linked.linearIssueDisplay,
    jiraIssueDisplay: linked.jiraIssueDisplay,
    prDisplay: review.prDisplay,
    linkedGitLabMR: review.linkedGitLabMR,
    linkedBitbucketPR: review.linkedBitbucketPR,
    linkedAzureDevOpsPR: review.linkedAzureDevOpsPR,
    linkedGiteaPR: review.linkedGiteaPR,
    cardProps: foundation.cardProps,
    newCardStyle: foundation.newCardStyle,
    compactCards: foundation.compactCards,
    agentActivityDisplayMode: foundation.agentActivityDisplayMode,
    workspacePorts: foundation.workspacePorts,
    openTaskPage: foundation.openTaskPage,
    updateWorktreeMeta: foundation.updateWorktreeMeta,
    settings: foundation.settings
  })

  return {
    ...props,
    ...foundation,
    ...review,
    ...linked,
    detailsHoverControl,
    showStatus,
    showIssue,
    showLinearIssue,
    showJiraIssue,
    showPR,
    showAutomation,
    showCli,
    showComment,
    showPorts,
    shouldRefreshHostedReview,
    ...activation,
    showDeleteQuickAction,
    ...workspaceActions,
    ...secondary
  }
}

export type WorktreeCardController = ReturnType<typeof useWorktreeCardController>
