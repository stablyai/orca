import React from 'react'
import { openAnnotationLocation } from '@/components/editor/check-details/actions/check-annotation-open'
import { useTranslate } from '@/i18n/use-translate'
import { PRCommentsList } from '../comments/comments-list'
import { resolveChecksPanelHostedReviewModifierDestination } from '../review-actions/checks-panel-hosted-review-click-routing'
import { useAzureDevOpsReviewData } from '../review-data/use-azure-devops-review-data'
import type { ChecksPanelActiveContentModel } from './active-content-props'
import { AzureDevOpsReviewers } from './azure-devops-reviewers'
import { ChecksList } from './checks-list'
import { ChecksPanelUpdatedAtMetadata } from './checks-panel-updated-at-metadata'
import { ChecksPanelReviewHeader } from './review-header'

/** Read-only: Orca shows an Azure DevOps PR's reviewers, policies and threads; votes and replies stay in Azure DevOps. */
export function AzureDevOpsActiveContent({
  model
}: {
  model: ChecksPanelActiveContentModel
}): React.JSX.Element | null {
  const t = useTranslate()
  const {
    activeReview,
    activeWorktree,
    activeWorktreeId,
    handleLinkAnotherReview,
    handleOpenPR,
    handleRefresh,
    handleUnlinkReview,
    isRefreshing,
    manualRefreshError,
    repo,
    setChecksPanelContentRef,
    settings,
    stateRequestKey
  } = model
  const data = useAzureDevOpsReviewData({
    repo: repo ?? null,
    worktree: activeWorktree ?? null,
    number: activeReview?.number ?? 0,
    updatedAt: activeReview?.updatedAt,
    isRefreshing
  })
  if (!activeReview) {
    return null
  }
  const error = manualRefreshError ?? data.error
  return (
    <div ref={setChecksPanelContentRef} className="flex-1 overflow-auto scrollbar-sleek">
      {error ? (
        <div
          role="alert"
          className="border-b border-border/50 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      ) : null}
      <div className="space-y-2.5 border-b border-border px-3 py-3">
        <ChecksPanelReviewHeader
          review={activeReview}
          isRefreshing={isRefreshing}
          canUnlinkReview={false}
          canLinkAnotherReview={false}
          modifierHintDestination={resolveChecksPanelHostedReviewModifierDestination(
            settings,
            Boolean(activeWorktreeId)
          )}
          onRefresh={() => void handleRefresh()}
          onOpenReview={handleOpenPR}
          onUnlinkReview={handleUnlinkReview}
          onLinkAnotherReview={handleLinkAnotherReview}
        />
        <div className="text-[12px] leading-snug text-foreground">{activeReview.title}</div>
        {activeReview.updatedAt ? (
          <ChecksPanelUpdatedAtMetadata reviewShortLabel="PR" updatedAt={activeReview.updatedAt} />
        ) : null}
        <div className="text-[11px] text-muted-foreground">
          {t(
            'auto.components.right.sidebar.ChecksPanel.azureReadOnlyNote',
            'Vote, reply and complete this pull request in Azure DevOps.'
          )}
        </div>
      </div>
      <AzureDevOpsReviewers reviewers={data.reviewers} />
      <ChecksList
        checks={data.checks}
        checksError={null}
        checksLoading={data.loading && data.checks.length === 0}
        checksRead={data.read}
        checkDetailsContextKey={stateRequestKey}
      />
      <PRCommentsList
        comments={data.comments}
        commentsLoading={data.loading && data.comments.length === 0}
        loadingSkeleton={data.loading && data.comments.length === 0}
        commentsRead={data.read}
        reviewKind="PR"
        commentsDisabled
        selectionContextKey={stateRequestKey}
        onOpenLocation={
          activeWorktree
            ? (path, line) =>
                openAnnotationLocation({
                  worktreeId: activeWorktree.id,
                  executionHostId: activeWorktree.hostId,
                  path,
                  line
                })
            : undefined
        }
      />
    </div>
  )
}
