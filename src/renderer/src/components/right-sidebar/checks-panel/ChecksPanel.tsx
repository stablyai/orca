import React from 'react'
import { useChecksPanelControllerState } from './use-checks-panel-controller-state'
import { useChecksPanelContextState } from './use-checks-panel-context-state'
import { useChecksPanelReviewState } from './use-checks-panel-review-state'
import { useChecksPanelGeneration } from './review-actions/use-checks-panel-generation'
import { useChecksPanelComposerState } from './use-checks-panel-composer-state'
import { useChecksPanelForegroundEffects } from './refresh/use-checks-panel-foreground-effects'
import { useChecksPanelGitStatusEffects } from './refresh/use-checks-panel-git-status-effects'
import { useChecksPanelConflictRefresh } from './refresh/use-checks-panel-conflict-refresh'
import { useChecksPanelPolling } from './refresh/use-checks-panel-polling'
import { useChecksPanelReviewData } from './use-checks-panel-review-data'
import { useChecksPanelManualRefresh } from './refresh/use-checks-panel-manual-refresh'
import { useChecksPanelEntryRefreshAndTitleActions } from './refresh/use-checks-panel-entry-refresh-and-title-actions'
import { useChecksPanelPRDetailRecovery } from './refresh/use-checks-panel-pr-detail-recovery'
import { useChecksPanelCommentResolution } from './comments/use-checks-panel-comment-resolution'
import { useChecksPanelCommentMutations } from './comments/use-checks-panel-comment-mutations'
import { useChecksPanelAiQueue } from './review-actions/use-checks-panel-ai-queue'
import { useChecksPanelAiAcknowledgement } from './review-actions/use-checks-panel-ai-acknowledgement'
import { useChecksPanelCheckAndReviewActions } from './review-actions/use-checks-panel-check-and-review-actions'
import { useChecksPanelBranchActions } from './review-actions/use-checks-panel-branch-actions'
import { useChecksPanelCreateReview } from './review-actions/use-checks-panel-create-review'
import { ChecksPanelEmptyContent } from './presentation/empty-content'
import { ChecksPanelActiveContent } from './presentation/active-content'
export default function ChecksPanel(): React.JSX.Element {
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
  // After entry refresh registers its own read, so recovery waits for it instead of racing it.
  const recoveryModel = Object.assign(entryModel, useChecksPanelPRDetailRecovery(entryModel))
  const resolutionModel = Object.assign(
    recoveryModel,
    useChecksPanelCommentResolution(recoveryModel)
  )
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

  if (!model.activeWorktree || model.isFolder || !model.activeReview) {
    return <ChecksPanelEmptyContent model={model} />
  }

  return <ChecksPanelActiveContent model={model} />
}
