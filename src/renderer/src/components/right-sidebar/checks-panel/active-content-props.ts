import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import type { ChecksPanelCommentResolutionState } from './use-checks-panel-comment-resolution'
import type { ChecksPanelAiAcknowledgementState } from './use-checks-panel-ai-acknowledgement'
import type { ChecksPanelReviewDataState } from './use-checks-panel-review-data'
import type { ChecksPanelCommentMutationState } from './use-checks-panel-comment-mutations'
import type { ChecksPanelEntryRefreshAndTitleActionsState } from './use-checks-panel-entry-refresh-and-title-actions'
import type { ChecksPanelCheckAndReviewActionsState } from './use-checks-panel-check-and-review-actions'
import type { ChecksPanelRefreshState } from './use-checks-panel-manual-refresh'
import type { ChecksPanelAiQueueState } from './use-checks-panel-ai-queue'
import type { ChecksPanelReviewState } from './use-checks-panel-review-state'
import type { ChecksPanelComposerState } from './use-checks-panel-composer-state'

export type ChecksPanelActiveContentModel = Pick<
  ChecksPanelControllerState,
  | 'activeConnectionId'
  | 'activeSourceControlLaunchPlatform'
  | 'activeWorktree'
  | 'activeWorktreeId'
  | 'agentComposerState'
  | 'checks'
  | 'checksLoading'
  | 'claimedCommentResolutionRef'
  | 'commentResolutionLaunchAcceptedRef'
  | 'comments'
  | 'commentsLoading'
  | 'commentsSelectionClearRequest'
  | 'conflictDetailsRefreshing'
  | 'detachedHeadDisplay'
  | 'editingTitle'
  | 'isFixingChecksWithAI'
  | 'isRefreshing'
  | 'isResolvingConflictsWithAI'
  | 'pendingCommentResolutionRef'
  | 'repo'
  | 'saveLaunchActionDefault'
  | 'setAgentComposerState'
  | 'settings'
  | 'titleDraft'
  | 'titleInputRef'
  | 'titleSaving'
  | 'setTitleDraft'
> &
  Pick<
    ChecksPanelContextState,
    | 'activeConflictReview'
    | 'activeGitLabReview'
    | 'activeReview'
    | 'linkedGitLabMR'
    | 'linkedPR'
    | 'pr'
    | 'prRefreshState'
    | 'setChecksPanelContentRef'
  > &
  Pick<
    ChecksPanelCommentResolutionState,
    | 'aiActionDisabledReason'
    | 'canTargetPRComments'
    | 'commentsDisabledReason'
    | 'handleResolve'
    | 'resolveCommentsWithAIDisabledReason'
  > &
  Pick<
    ChecksPanelAiAcknowledgementState,
    | 'consumeClaimedCommentResolutionAfterDeliveryRef'
    | 'handleLaunchAborted'
    | 'handleLaunchAccepted'
  > &
  Pick<ChecksPanelReviewDataState, 'getGitLabProjectRef' | 'handleLoadCheckDetails'> &
  Pick<
    ChecksPanelCommentMutationState,
    | 'handleAddPRComment'
    | 'handleDeleteComment'
    | 'handleEditComment'
    | 'handleReplyToComment'
    | 'handleSetReaction'
  > &
  Pick<
    ChecksPanelEntryRefreshAndTitleActionsState,
    | 'handleCancelEdit'
    | 'handleSaveTitle'
    | 'handleStartEdit'
    | 'handleTitleKeyDown'
    | 'refreshHostedReviewAfterMutation'
  > &
  Pick<
    ChecksPanelCheckAndReviewActionsState,
    | 'handleFixChecksWithAI'
    | 'handleLinkAnotherReview'
    | 'handleOpenPR'
    | 'handleOpenStackPR'
    | 'handleUnlinkReview'
  > &
  Pick<ChecksPanelRefreshState, 'handleRefresh'> &
  Pick<ChecksPanelAiQueueState, 'handleResolveCommentsWithAI' | 'handleResolveConflictsWithAI'> &
  Pick<ChecksPanelReviewState, 'sourceControlAiActionsVisible'> &
  Pick<ChecksPanelComposerState, 'stateRequestKey'>
