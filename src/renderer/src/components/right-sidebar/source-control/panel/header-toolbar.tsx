import React from 'react'
import { createPortal } from 'react-dom'
import type { GitBranchCompareSummary } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitBranchLineTotal } from '../../../../../../shared/git/status/git-status-types'
import type { SourceControlViewMode } from '../../../../../../shared/ui-chrome/ui-chrome-types'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { PrimaryAction } from '../review/source-control-primary-action-types'
import type { WorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/row-display/git-identity-display'
import {
  HostedReviewToolbarLink,
  CreatePrHeaderButton,
  SuppressedGitHubPRToolbar
} from './header-review-actions'
import { SourceControlBranchContextRow } from './branch-context-row'
import type { BaseRebaseActions } from './base-rebase-control'
import {
  SourceControlHeaderOverflowMenu,
  type SourceControlPanelActions
} from './header-overflow-menu'
import { useSourceControlHeaderActionsSlot } from './header-actions-slot'
import { useSourceControlScope } from './worktree-scope'
import {
  SourceControlFilterRow,
  SourceControlFilterToggle,
  type SourceControlFileFilterProps
} from './file-filter-controls'

type SourceControlHeaderToolbarProps = SourceControlFileFilterProps & {
  visibleCreatePrHeaderAction: PrimaryAction | null
  hostedReview: HostedReviewInfo | null
  isCreatePrIntentInFlight: boolean
  isCreatingPr: boolean
  onCreatePrHeaderClick: () => void
  onOpenHostedReviewInChecks: () => void
  suppressedGitHubPRNumber: number | null
  onRelinkSuppressedGitHubPR: () => void
  panelActions: SourceControlPanelActions
  onRefreshBranchCompare: () => void
  branchSummary: GitBranchCompareSummary | null
  compareBaseRef: string | null
  headControl?: React.ReactNode
  headDisplay?: WorktreeGitIdentityDisplay | null
  branchLineTotal?: GitBranchLineTotal | null
  rebase?: BaseRebaseActions | null
  /** Labeled Git Graph button; null where the context has no Git history (folders). */
  graphControl?: React.ReactNode
  /** The file-list header carries filter, Graph and overflow, so the panel header has no tool row. */
  toolsInFileListHeader: boolean
}

export function SourceControlHeaderToolbar({
  filterQuery,
  filterExpanded,
  onFilterQueryChange,
  onFilterExpandedChange,
  visibleCreatePrHeaderAction,
  hostedReview,
  isCreatePrIntentInFlight,
  isCreatingPr,
  onCreatePrHeaderClick,
  onOpenHostedReviewInChecks,
  suppressedGitHubPRNumber,
  onRelinkSuppressedGitHubPR,
  panelActions,
  onRefreshBranchCompare,
  branchSummary,
  compareBaseRef,
  headDisplay = null,
  headControl,
  branchLineTotal,
  rebase,
  graphControl,
  toolsInFileListHeader
}: SourceControlHeaderToolbarProps): React.JSX.Element | null {
  const embedded = useSourceControlScope() !== null
  const actionsSlot = useSourceControlHeaderActionsSlot()
  const filterProps = { filterQuery, filterExpanded, onFilterQueryChange, onFilterExpandedChange }

  const reviewControl = hostedReview ? (
    <HostedReviewToolbarLink
      review={hostedReview}
      onOpenHostedReviewInChecks={onOpenHostedReviewInChecks}
    />
  ) : suppressedGitHubPRNumber !== null ? (
    <SuppressedGitHubPRToolbar
      number={suppressedGitHubPRNumber}
      onRelink={onRelinkSuppressedGitHubPR}
    />
  ) : visibleCreatePrHeaderAction ? (
    <CreatePrHeaderButton
      action={visibleCreatePrHeaderAction}
      isCreatePrIntentInFlight={isCreatePrIntentInFlight}
      isCreatingPr={isCreatingPr}
      onClick={onCreatePrHeaderClick}
    />
  ) : null

  const branchContext = (
    <SourceControlBranchContextRow
      summary={branchSummary}
      compareBaseRef={compareBaseRef}
      headDisplay={headDisplay}
      headControl={headControl}
      branchLineTotal={branchLineTotal}
      reviewControl={reviewControl}
      rebase={rebase}
      onRetry={onRefreshBranchCompare}
    />
  )

  if (embedded) {
    // The card header owns filter, Graph and overflow; the panel keeps the filter row and branch rows.
    return (
      <>
        {actionsSlot
          ? createPortal(
              <>
                {graphControl}
                <SourceControlFilterToggle {...filterProps} embedded />
                <SourceControlHeaderOverflowMenu panelActions={panelActions} />
              </>,
              actionsSlot
            )
          : null}
        <SourceControlHeaderBlock>
          {filterExpanded ? (
            <div className="mb-1.5 flex min-w-0 items-center gap-1.5 border-b border-border pb-1.5">
              <SourceControlFilterRow {...filterProps} />
            </div>
          ) : null}
          {branchContext}
        </SourceControlHeaderBlock>
      </>
    )
  }

  if (toolsInFileListHeader) {
    return <SourceControlHeaderBlock>{branchContext}</SourceControlHeaderBlock>
  }

  // Folders without Git history have no file-list header, so their tools keep a header row.
  return (
    <div className="border-b border-border px-3 pt-1.5 pb-1">
      <div
        className="flex min-w-0 items-center gap-1"
        data-filter-expanded={filterExpanded ? 'true' : 'false'}
      >
        {filterExpanded ? (
          <SourceControlFilterRow {...filterProps} />
        ) : (
          <>
            <span className="min-w-0 flex-1" aria-hidden="true" />
            {graphControl}
            <SourceControlFilterToggle {...filterProps} embedded={false} />
            <SourceControlHeaderOverflowMenu panelActions={panelActions} />
          </>
        )}
      </div>
      {branchContext}
    </div>
  )
}

/** Renders its block only when a child has content, so an empty header leaves no bordered strip. */
function SourceControlHeaderBlock({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className="flex flex-col border-b border-border px-3 py-1 empty:hidden"
      data-testid="source-control-header"
    >
      {children}
    </div>
  )
}

export function shouldShowSourceControlCompareUnavailableCard(
  summary: GitBranchCompareSummary | null | undefined,
  hasUncommittedEntries: boolean,
  hasBranchEntries: boolean,
  hasFilter: boolean
): boolean {
  if (!summary || summary.status === 'loading' || summary.status === 'ready' || hasFilter) {
    return false
  }
  return !hasUncommittedEntries && !hasBranchEntries
}

export function getNextSourceControlViewMode(mode: SourceControlViewMode): SourceControlViewMode {
  return mode === 'list' ? 'tree' : 'list'
}
