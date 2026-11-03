import React from 'react'
import { Button } from '@/components/ui/button'
import { DetachedHeadBadge } from '@/components/DetachedHeadBadge'
import { CreateHostedReviewComposer } from '../CreateHostedReviewComposer'
import {
  getChecksPanelReviewState,
  shouldShowChecksPanelPublishBranchAction
} from '../checks-panel-empty-state'
import { openChecksPanelHostedReviewUrl } from '../checks-panel-hosted-review-click-routing'
import { isRateLimitRefresh } from '../checks-panel-review-state-model'
import { isMacPlatform } from '../../terminal-pane/terminal-link-open-hints'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { localizedHostedReviewCopy } from '@/i18n/hosted-review-localized-copy'
import { isGitHubPRSuppressed } from '../../../../../shared/worktree/github-pr-suppression'
import type { ChecksPanelEmptyContentModel } from './empty-content-props'
import { useNow } from '@/hooks/use-now'

export function ChecksPanelEmptyContent({
  model
}: {
  model: ChecksPanelEmptyContentModel
}): React.JSX.Element | null {
  // Tick only for GitHub retry timing; idle/folder composers must not rerender every second.
  const now = useNow(
    1000,
    model.prRefreshState?.nextAutoRetryAt !== undefined ||
      model.prRefreshState?.retryDisabledUntil !== undefined
  )
  const {
    activeReview,
    activeWorktree,
    activeWorktreeId,
    branch,
    checksPanelHasHardRefreshError,
    checksPanelReviewLookup,
    checksPanelReviewLookupResult,
    confirmedReadiness,
    conflictOperation,
    createComposerOpen,
    createPrError,
    createPrPushFirst,
    detachedHeadDisplay,
    emptyRefreshing,
    gitStatusInputs,
    gitStatusProbeErrorContextKey,
    handleCancelGeneratePullRequestFields,
    handleCreatePullRequest,
    handleGeneratePullRequestFields,
    handleLinkSuppressedPullRequest,
    handlePrBaseChange,
    handlePrTitleChange,
    handlePublishBranch,
    handleRefresh,
    handleSyncBranch,
    hardRefreshError,
    hostedReviewCreateCopy,
    hostedReviewCreateProvider,
    hostedReviewCreation,
    isCreatingPr,
    isFolder,
    isGitHubReviewContext,
    isPublishingBranch,
    isRemoteOperationActive,
    isSyncingBranch,
    linkedGitLabMR,
    linkedPR,
    linkedReviewNumber,
    manualRefreshError,
    panelContextKey,
    prAiGenerationEnabled,
    prBase,
    prBaseQuery,
    prBaseResults,
    prBaseSearchError,
    prBaseSearchPending,
    prBody,
    prDraft,
    prGenerateDisabled,
    prGenerateDisabledReason,
    prGenerateError,
    prGenerating,
    prNumber,
    prRepoDefaultBaseRef,
    prStackedCreationSupported,
    prTitle,
    prRefreshState,
    publishActionHasUncommittedChanges,
    publishActionRemoteStatus,
    setEmptyRefreshing,
    setPrBaseQuery,
    setPrBaseResults,
    setPrBody,
    setPrDraft,
    sourceControlAiActionsVisible,
    stackParentReview,
    suppressedGitHubPR
  } = model
  if (!activeWorktree) {
    return (
      <div className="px-4 py-6">
        <div className="text-sm font-medium text-foreground">
          {translate(
            'auto.components.right.sidebar.ChecksPanel.a4ef4e0832',
            'No workspace selected'
          )}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.ChecksPanel.b5dd73a105',
            'Select a workspace to view checks'
          )}
        </div>
      </div>
    )
  }
  if (isFolder) {
    return (
      <div className="px-4 py-6">
        <div className="text-sm font-medium text-foreground">
          {translate('auto.components.right.sidebar.ChecksPanel.976cefd02f', 'Checks unavailable')}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.ChecksPanel.dda5924a40',
            'Checks require a Git branch and hosted review context'
          )}
        </div>
      </div>
    )
  }

  const currentGitHubPRIsSuppressed =
    prNumber !== null && isGitHubPRSuppressed({ linkedPR, suppressedGitHubPR }, prNumber)
  if (!activeReview && linkedReviewNumber === null && currentGitHubPRIsSuppressed) {
    return (
      <div className="px-4 py-6">
        <div className="text-sm font-medium text-foreground">
          {translate('checksPanel.unlinked.title', 'Pull request unlinked')}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {translate(
            'checksPanel.unlinked.description',
            'PR #{{number}} is hidden for this workspace. Link it again to restore checks and review details.',
            { number: suppressedGitHubPR }
          )}
        </div>
        <Button size="xs" className="mt-3" onClick={handleLinkSuppressedPullRequest}>
          {translate('checksPanel.unlinked.relink', 'Link PR #{{number}}', {
            number: suppressedGitHubPR
          })}
        </Button>
      </div>
    )
  }

  if (!activeReview) {
    // Detached HEAD during Git operations does not mean the original branch lost its PR.
    const operationInProgress = conflictOperation !== 'unknown'
    const operationLabel =
      conflictOperation === 'rebase'
        ? translate('auto.components.right.sidebar.checks.panel.content.operation.rebase', 'Rebase')
        : conflictOperation === 'merge'
          ? translate('auto.components.right.sidebar.checks.panel.content.operation.merge', 'Merge')
          : conflictOperation === 'cherry-pick'
            ? translate(
                'auto.components.right.sidebar.checks.panel.content.operation.cherryPick',
                'Cherry-pick'
              )
            : null
    const emptyReviewIsGitLab =
      linkedGitLabMR !== null || hostedReviewCreation?.provider === 'gitlab'
    const emptyReviewCopy = localizedHostedReviewCopy(emptyReviewIsGitLab ? 'gitlab' : 'github')
    const canPushCreate = hostedReviewCreation?.blockedReason === 'needs_push'
    const shouldPushBeforeCreateReview = createPrPushFirst || canPushCreate
    const canPublishBranch =
      isPublishingBranch ||
      (!publishActionHasUncommittedChanges &&
        shouldShowChecksPanelPublishBranchAction({
          hostedReviewBlockedReason: hostedReviewCreation?.blockedReason,
          hasUpstream: publishActionRemoteStatus?.hasUpstream,
          hasCurrentBranch: Boolean(branch)
        }))
    // Keep GitHub hard errors sticky so retry state cannot briefly restore the composer.
    const emptyRefreshInput = !isGitHubReviewContext
      ? undefined
      : checksPanelHasHardRefreshError && hardRefreshError
        ? { status: 'error' as const, errorType: hardRefreshError.errorType }
        : prRefreshState
          ? {
              status: prRefreshState.status,
              errorType: prRefreshState.errorType,
              skippedReason: prRefreshState.skippedReason,
              nextAutoRetryAt: prRefreshState.nextAutoRetryAt,
              retryDisabledUntil: prRefreshState.retryDisabledUntil
            }
          : undefined
    const emptyGitStatusPhase: 'loading' | 'ready' | 'error' =
      gitStatusInputs.hasUncommittedChanges !== undefined
        ? 'ready'
        : gitStatusProbeErrorContextKey === panelContextKey
          ? 'error'
          : 'loading'
    const reviewState = getChecksPanelReviewState({
      operationLabel,
      reviewLabel: emptyReviewCopy.reviewLabel,
      reviewShortLabel: emptyReviewCopy.shortLabel,
      providerName: hostedReviewCreateCopy.providerName,
      isGitHubProvider: hostedReviewCreateProvider === 'github',
      reviewLookup: checksPanelReviewLookup,
      openReviewUrl: checksPanelReviewLookupResult.openReviewUrl,
      eligibilityBlockedReason: hostedReviewCreation?.blockedReason,
      // Preserved-composer mode uses confirmed readiness rather than the live create gate.
      confirmedReadiness: confirmedReadiness.confirmed,
      confirmedNeedsPush: confirmedReadiness.needsPush,
      refresh: emptyRefreshInput,
      gitStatusPhase: emptyGitStatusPhase,
      hasUpstream: publishActionRemoteStatus?.hasUpstream,
      hasCurrentBranch: Boolean(branch)
    })
    // Classified GitHub states carry the next step (sign in, or wait for the limit), so they win.
    const refreshFailure =
      emptyRefreshInput?.status === 'error' || isRateLimitRefresh(emptyRefreshInput)
        ? null
        : manualRefreshError
    const emptyStateCopy = refreshFailure
      ? {
          title: translate('auto.components.status.bar.tooltip.e740f92596', 'Refresh failed'),
          description: refreshFailure
        }
      : { title: reviewState.title, description: reviewState.description }
    const reviewStateAutoRetryText =
      reviewState.autoRetryAt !== undefined && reviewState.autoRetryAt > now
        ? translate(
            'auto.components.right.sidebar.ChecksPanel.review.auto_retry',
            'Orca will retry at {{time}}.',
            { time: new Date(reviewState.autoRetryAt).toLocaleTimeString(getIntlLocale()) }
          )
        : null
    const reviewRecoveryRetryDisabled =
      reviewState.retryDisabledUntil !== undefined && now < reviewState.retryDisabledUntil
    const reviewRecoveryLabelIsRefresh = reviewState.recovery.includes('refresh')
    const reviewShowRetryOrRefresh =
      Boolean(refreshFailure) ||
      reviewState.recovery.includes('retry') ||
      reviewRecoveryLabelIsRefresh
    const reviewShowOpenReview =
      reviewState.recovery.includes('open_review') && Boolean(reviewState.openReviewUrl)
    const reviewShowSyncBranch = reviewState.workflowAction === 'sync_branch'
    // Keep recovery actions independent so preserved composers still expose Retry after transient failures.
    const reviewShowActionRow =
      canPublishBranch ||
      reviewShowSyncBranch ||
      (reviewShowOpenReview && Boolean(reviewState.openReviewUrl)) ||
      reviewShowRetryOrRefresh
    return (
      <div className="px-4 py-6">
        {detachedHeadDisplay && (
          <div className="mb-3">
            <DetachedHeadBadge display={detachedHeadDisplay} side="bottom" />
          </div>
        )}
        <div className="text-sm font-medium text-foreground">{emptyStateCopy.title}</div>
        <div className="mt-1 text-xs text-muted-foreground">{emptyStateCopy.description}</div>
        {!refreshFailure && reviewState.detail ? (
          <div className="mt-1 text-xs text-muted-foreground">{reviewState.detail}</div>
        ) : null}
        {!refreshFailure && reviewStateAutoRetryText ? (
          <div className="mt-1 text-xs text-muted-foreground">{reviewStateAutoRetryText}</div>
        ) : null}
        {!operationInProgress && createComposerOpen ? (
          <div className="mt-4 border-t border-border pt-3">
            <CreateHostedReviewComposer
              key={panelContextKey}
              className="p-0"
              provider={hostedReviewCreateProvider}
              branch={branch}
              base={prBase}
              repoDefaultBase={prRepoDefaultBaseRef}
              setBase={handlePrBaseChange}
              title={prTitle}
              setTitle={handlePrTitleChange}
              body={prBody}
              setBody={setPrBody}
              draft={prDraft}
              setDraft={setPrDraft}
              stackedCreationSupported={prStackedCreationSupported}
              stackParentReview={stackParentReview}
              baseQuery={prBaseQuery}
              setBaseQuery={setPrBaseQuery}
              baseResults={prBaseResults}
              setBaseResults={setPrBaseResults}
              baseSearchPending={prBaseSearchPending}
              baseSearchError={prBaseSearchError}
              aiGenerationEnabled={sourceControlAiActionsVisible && prAiGenerationEnabled}
              generating={prGenerating}
              generateDisabled={prGenerateDisabled}
              generateDisabledReason={prGenerateDisabledReason}
              generateError={prGenerateError}
              createError={createPrError}
              isCreating={isCreatingPr}
              pushBeforeCreate={shouldPushBeforeCreateReview}
              primaryAction={{
                disabled: isCreatingPr || isPublishingBranch || isRemoteOperationActive,
                title: shouldPushBeforeCreateReview
                  ? translate(
                      'auto.components.right.sidebar.ChecksPanel.98f4c37b33',
                      'Push & Create {{value0}}',
                      { value0: emptyReviewCopy.shortLabel }
                    )
                  : translate(
                      'auto.components.right.sidebar.ChecksPanel.889cdfba04',
                      'Create {{value0}}',
                      { value0: emptyReviewCopy.shortLabel }
                    )
              }}
              onGenerate={() => void handleGeneratePullRequestFields()}
              onCancelGenerate={handleCancelGeneratePullRequestFields}
              onPrimaryAction={(stacked) => void handleCreatePullRequest(stacked)}
            />
          </div>
        ) : null}
        {!operationInProgress && reviewShowActionRow && (
          <div className="mt-3 flex flex-wrap gap-2">
            {canPublishBranch && (
              <Button
                size="xs"
                disabled={isPublishingBranch || isRemoteOperationActive}
                onClick={handlePublishBranch}
              >
                {isPublishingBranch
                  ? translate('auto.components.right.sidebar.ChecksPanel.fdb27637f2', 'Publishing…')
                  : translate(
                      'auto.components.right.sidebar.ChecksPanel.6633c7a1fb',
                      'Publish Branch'
                    )}
              </Button>
            )}
            {reviewShowSyncBranch && (
              <Button
                size="xs"
                disabled={isSyncingBranch || isRemoteOperationActive}
                onClick={() => void handleSyncBranch()}
              >
                {isSyncingBranch
                  ? translate('auto.components.right.sidebar.ChecksPanel.sync.pending', 'Syncing…')
                  : translate(
                      'auto.components.right.sidebar.ChecksPanel.sync.branch',
                      'Sync Branch'
                    )}
              </Button>
            )}
            {reviewShowOpenReview && reviewState.openReviewUrl ? (
              <Button
                size="xs"
                variant="outline"
                disabled={isRemoteOperationActive}
                onClick={(event) =>
                  openChecksPanelHostedReviewUrl({
                    url: reviewState.openReviewUrl as string,
                    event,
                    isMac: isMacPlatform(),
                    worktreeId: activeWorktreeId
                  })
                }
              >
                {translate(
                  'auto.components.right.sidebar.ChecksPanel.review.open_review',
                  'Open Review'
                )}
              </Button>
            ) : null}
            {reviewShowRetryOrRefresh ? (
              <Button
                size="xs"
                variant="outline"
                disabled={
                  emptyRefreshing ||
                  isPublishingBranch ||
                  isRemoteOperationActive ||
                  reviewRecoveryRetryDisabled
                }
                onClick={() => {
                  if (!activeWorktreeId) {
                    return
                  }
                  setEmptyRefreshing(true)
                  void handleRefresh().finally(() => {
                    setEmptyRefreshing(false)
                  })
                }}
              >
                {emptyRefreshing
                  ? translate('auto.components.right.sidebar.ChecksPanel.71026ca2cb', 'Refreshing…')
                  : reviewRecoveryLabelIsRefresh
                    ? translate('auto.components.right.sidebar.ChecksPanel.7f4489f370', 'Refresh')
                    : translate('auto.components.right.sidebar.ChecksPanel.review.retry', 'Retry')}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    )
  }
  return null
}
