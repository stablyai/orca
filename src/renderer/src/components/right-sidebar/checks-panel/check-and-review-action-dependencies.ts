import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelComposerState } from './use-checks-panel-composer-state'
import type { ChecksPanelReviewState } from './use-checks-panel-review-state'

export type ChecksPanelCheckAndReviewActionsInput = Pick<
  ChecksPanelContextState,
  | 'activeReview'
  | 'linkedAzureDevOpsPR'
  | 'linkedBitbucketPR'
  | 'linkedGiteaPR'
  | 'linkedGitLabMR'
  | 'linkedPR'
  | 'pr'
  | 'prCacheKey'
> &
  Pick<
    ChecksPanelControllerState,
    | 'activeWorktree'
    | 'activeWorktreeId'
    | 'asyncResultKeyRef'
    | 'branch'
    | 'checks'
    | 'fetchHostedReviewForBranch'
    | 'fetchPRCheckDetails'
    | 'fetchPRChecks'
    | 'fetchPRComments'
    | 'fetchPRForBranch'
    | 'gitLabProjectRefRef'
    | 'isFixingChecksWithAI'
    | 'openModal'
    | 'panelContextKey'
    | 'panelContextKeyRef'
    | 'repo'
    | 'settings'
    | 'setChecks'
    | 'setChecksLoading'
    | 'setComments'
    | 'setCommentsLoading'
    | 'setIsFixingChecksWithAI'
    | 'updateWorktreeMeta'
  > &
  Pick<ChecksPanelComposerState, 'isCurrentAsyncResult' | 'stateRequestKey'> &
  Pick<ChecksPanelReviewState, 'sourceControlAiActionsVisible'>
