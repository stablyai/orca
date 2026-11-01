import React from 'react'
import { useChecksPanelControllerState } from './checks-panel/use-checks-panel-controller-state'
import { useChecksPanelContextState } from './checks-panel/use-checks-panel-context-state'
import { useChecksPanelReviewState } from './checks-panel/use-checks-panel-review-state'
import { useChecksPanelGeneration } from './checks-panel/use-checks-panel-generation'
import { useChecksPanelComposerState } from './checks-panel/use-checks-panel-composer-state'
import { useChecksPanelForegroundEffects } from './checks-panel/use-checks-panel-foreground-effects'
import { useChecksPanelGitStatusEffects } from './checks-panel/use-checks-panel-git-status-effects'
import { useChecksPanelConflictRefresh } from './checks-panel/use-checks-panel-conflict-refresh'
import { useChecksPanelPolling } from './checks-panel/use-checks-panel-polling'
import { useChecksPanelReviewData } from './checks-panel/use-checks-panel-review-data'
import { useChecksPanelManualRefresh } from './checks-panel/use-checks-panel-manual-refresh'
import { useChecksPanelEntryRefreshAndTitleActions } from './checks-panel/use-checks-panel-entry-refresh-and-title-actions'
import { useChecksPanelCommentResolution } from './checks-panel/use-checks-panel-comment-resolution'
import { useChecksPanelCommentMutations } from './checks-panel/use-checks-panel-comment-mutations'
import { useChecksPanelAiQueue } from './checks-panel/use-checks-panel-ai-queue'
import { useChecksPanelAiAcknowledgement } from './checks-panel/use-checks-panel-ai-acknowledgement'
import { useChecksPanelCheckAndReviewActions } from './checks-panel/use-checks-panel-check-and-review-actions'
import { useChecksPanelBranchActions } from './checks-panel/use-checks-panel-branch-actions'
import { useChecksPanelCreateReview } from './checks-panel/use-checks-panel-create-review'
import { ChecksPanelEmptyContent } from './checks-panel/empty-content'
import { ChecksPanelActiveContent } from './checks-panel/active-content'
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

  if (!model.activeWorktree || model.isFolder || !model.activeReview) {
    return <ChecksPanelEmptyContent model={model} />
  }

  return <ChecksPanelActiveContent model={model} />
}
