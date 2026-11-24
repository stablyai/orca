import React from 'react'
import { useChecksPanelControllerState } from './panel/use-checks-panel-controller-state'
import { useChecksPanelContextState } from './review-state/use-checks-panel-context-state'
import { useChecksPanelReviewState } from './review-state/use-checks-panel-review-state'
import { useChecksPanelGeneration } from './review-actions/use-checks-panel-generation'
import { useChecksPanelComposerState } from './review-actions/use-checks-panel-composer-state'
import { useChecksPanelForegroundEffects } from './refresh/use-checks-panel-foreground-effects'
import { useChecksPanelGitStatusEffects } from './refresh/use-checks-panel-git-status-effects'
import { useChecksPanelConflictRefresh } from './refresh/use-checks-panel-conflict-refresh'
import { useChecksPanelPolling } from './refresh/use-checks-panel-polling'
import { useChecksPanelReviewData } from './review-data/use-checks-panel-review-data'
import { useChecksPanelManualRefresh } from './refresh/use-checks-panel-manual-refresh'
import { useChecksPanelEntryRefreshAndTitleActions } from './refresh/use-checks-panel-entry-refresh-and-title-actions'
import { useChecksPanelCommentResolution } from './comments/use-checks-panel-comment-resolution'
import { useChecksPanelCommentMutations } from './comments/use-checks-panel-comment-mutations'
import { useChecksPanelAiQueue } from './review-actions/use-checks-panel-ai-queue'
import { useChecksPanelAiAcknowledgement } from './review-actions/use-checks-panel-ai-acknowledgement'
import { useChecksPanelCheckAndReviewActions } from './review-actions/use-checks-panel-check-and-review-actions'
import { useChecksPanelBranchActions } from './review-actions/use-checks-panel-branch-actions'
import { useChecksPanelCreateReview } from './review-actions/use-checks-panel-create-review'
import { ChecksPanelEmptyContent } from './presentation/empty-content'
import { ChecksPanelActiveContent } from './presentation/active-content'
import { ChecksPanelLoadingAnnouncement } from './presentation/checks-panel-loading-announcement'
import { getChecksPanelRefreshErrorBannerLine } from '../hosted-review/provider-actions/github-refresh-error-copy'
import { useTranslate } from '@/i18n/use-translate'

export default function ChecksPanel(): React.JSX.Element {
  const t = useTranslate()
  const baseModel = useChecksPanelControllerState()
  const contextModel = Object.assign(baseModel, useChecksPanelContextState(baseModel))
  const reviewModel = Object.assign(contextModel, useChecksPanelReviewState(contextModel))
  const generationModel = Object.assign(reviewModel, useChecksPanelGeneration(reviewModel))
  const composerModel = Object.assign(generationModel, useChecksPanelComposerState(generationModel))
  useChecksPanelForegroundEffects(composerModel)
  useChecksPanelGitStatusEffects(composerModel)
  useChecksPanelConflictRefresh(composerModel)
  const pollingModel = Object.assign(composerModel, useChecksPanelPolling(composerModel))
  const dataModel = Object.assign(pollingModel, useChecksPanelReviewData(pollingModel))
  const refreshModel = Object.assign(dataModel, useChecksPanelManualRefresh(dataModel))
  const entryModel = Object.assign(
    refreshModel,
    useChecksPanelEntryRefreshAndTitleActions(refreshModel)
  )
  const resolutionModel = Object.assign(entryModel, useChecksPanelCommentResolution(entryModel))
  const mutationModel = Object.assign(
    resolutionModel,
    useChecksPanelCommentMutations(resolutionModel)
  )
  const acknowledgementModel = Object.assign(
    mutationModel,
    useChecksPanelAiAcknowledgement(mutationModel)
  )
  const queueModel = Object.assign(
    acknowledgementModel,
    useChecksPanelAiQueue(acknowledgementModel)
  )
  const reviewActionsModel = Object.assign(
    queueModel,
    useChecksPanelCheckAndReviewActions(queueModel)
  )
  const branchActionsModel = Object.assign(
    reviewActionsModel,
    useChecksPanelBranchActions(reviewActionsModel)
  )
  const model = Object.assign(branchActionsModel, useChecksPanelCreateReview(branchActionsModel))

  const showActive = Boolean(model.activeWorktree && !model.isFolder && model.activeReview)
  // A classified GitHub failure says more than a manual one, so it wins; one banner either way.
  const refreshError =
    (model.activeReview?.provider === 'github' && model.prRefreshState?.status === 'error'
      ? getChecksPanelRefreshErrorBannerLine(model.prRefreshState.errorType, t)
      : null) ?? model.manualRefreshError
  const canReadDetails = Boolean(model.repo && (model.prNumber || model.activeGitLabReview))
  const canShowLoading =
    showActive &&
    model.isPanelVisible &&
    canReadDetails &&
    Boolean(model.stateRequestKey) &&
    !refreshError
  const coldChecks =
    canShowLoading && !model.checksLoaded && !model.gitLabPipelineCheck && !model.checksError
  const commentsError =
    model.commentsError ??
    (model.commentsUnavailable && !model.commentsLoading
      ? t('checksPanel.commentsUnavailable', 'Could not load comments.')
      : null)
  const coldComments = canShowLoading && !model.commentsLoaded && !commentsError
  return (
    <>
      <ChecksPanelLoadingAnnouncement
        loading={coldChecks || coldComments}
        reviewKey={model.stateRequestKey}
      />
      {showActive ? (
        <ChecksPanelActiveContent
          model={model}
          refreshError={refreshError}
          coldChecks={coldChecks}
          coldComments={coldComments}
          commentsError={commentsError}
        />
      ) : (
        <ChecksPanelEmptyContent model={model} />
      )}
    </>
  )
}
