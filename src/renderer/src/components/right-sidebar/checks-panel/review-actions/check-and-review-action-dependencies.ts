import type { ChecksPanelContextState } from '../review-state/use-checks-panel-context-state'
import type { ChecksPanelControllerState } from '../panel/use-checks-panel-controller-state'
import type { ChecksPanelComposerState } from './use-checks-panel-composer-state'
import type { ChecksPanelReviewState } from '../review-state/use-checks-panel-review-state'

export type ChecksPanelCheckAndReviewActionsInput = Pick<
  ChecksPanelContextState,
  | 'activeReview'
  | 'linkedAzureDevOpsPR'
  | 'linkedBitbucketPR'
  | 'linkedGiteaPR'
  | 'linkedGitLabMR'
  | 'linkedPR'
  | 'suppressedGitHubPR'
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
    | 'gitLabPipelineCheck'
    | 'gitLabProjectRefRef'
    | 'isFixingChecksWithAI'
    | 'localExecutionScope'
    | 'openModal'
    | 'panelContextKey'
    | 'panelContextKeyRef'
    | 'repo'
    | 'repoConnectionId'
    | 'runtimeEnvironmentId'
    | 'setChecks'
    | 'setChecksLoading'
    | 'setComments'
    | 'setCommentsLoading'
    | 'setIsFixingChecksWithAI'
    | 'updateWorktreeMeta'
  > &
  Pick<ChecksPanelComposerState, 'isCurrentAsyncResult' | 'stateRequestKey'> &
  Pick<ChecksPanelReviewState, 'sourceControlAiActionsVisible'>
