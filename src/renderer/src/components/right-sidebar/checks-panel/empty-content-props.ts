import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelReviewState } from './use-checks-panel-review-state'
import type { ChecksPanelComposerState } from './use-checks-panel-composer-state'
import type { ChecksPanelCreateReviewState } from './use-checks-panel-create-review'
import type { ChecksPanelBranchActionsState } from './use-checks-panel-branch-actions'
import type { ChecksPanelRefreshState } from './use-checks-panel-manual-refresh'

export type ChecksPanelEmptyContentModel = Pick<
  ChecksPanelContextState,
  'activeReview' | 'isFolder' | 'linkedGitLabMR' | 'prRefreshState'
> &
  Pick<
    ChecksPanelControllerState,
    | 'activeWorktree'
    | 'activeWorktreeId'
    | 'branch'
    | 'conflictOperation'
    | 'createPrError'
    | 'detachedHeadDisplay'
    | 'emptyRefreshing'
    | 'gitStatusProbeErrorContextKey'
    | 'hardRefreshError'
    | 'isCreatingPr'
    | 'isPublishingBranch'
    | 'isRemoteOperationActive'
    | 'isSyncingBranch'
    | 'panelContextKey'
    | 'setEmptyRefreshing'
  > &
  Pick<
    ChecksPanelReviewState,
    | 'checksPanelHasHardRefreshError'
    | 'checksPanelReviewLookup'
    | 'checksPanelReviewLookupResult'
    | 'confirmedReadiness'
    | 'createComposerOpen'
    | 'createPrPushFirst'
    | 'gitStatusInputs'
    | 'hostedReviewCreateCopy'
    | 'hostedReviewCreateProvider'
    | 'hostedReviewCreation'
    | 'isGitHubReviewContext'
    | 'publishActionHasUncommittedChanges'
    | 'publishActionRemoteStatus'
    | 'sourceControlAiActionsVisible'
  > &
  Pick<
    ChecksPanelComposerState,
    | 'handleCancelGeneratePullRequestFields'
    | 'handleGeneratePullRequestFields'
    | 'handlePrBaseChange'
    | 'handlePrTitleChange'
    | 'prAiGenerationEnabled'
    | 'prBase'
    | 'prBaseQuery'
    | 'prBaseResults'
    | 'prBaseSearchError'
    | 'prBaseSearchPending'
    | 'prBody'
    | 'prDraft'
    | 'prGenerateDisabled'
    | 'prGenerateDisabledReason'
    | 'prGenerateError'
    | 'prGenerating'
    | 'prRepoDefaultBaseRef'
    | 'prStackedCreationSupported'
    | 'prTitle'
    | 'setPrBaseQuery'
    | 'setPrBaseResults'
    | 'setPrBody'
    | 'setPrDraft'
    | 'stackParentReview'
  > &
  Pick<ChecksPanelCreateReviewState, 'handleCreatePullRequest'> &
  Pick<ChecksPanelBranchActionsState, 'handlePublishBranch' | 'handleSyncBranch'> &
  Pick<ChecksPanelRefreshState, 'handleRefresh'>
