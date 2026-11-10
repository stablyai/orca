import { ImeInput } from '@/lib/text-input/ime/ime-text-field'
import React, { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Search, X } from 'lucide-react'
import type { GitBranchCompareSummary } from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitBranchLineTotal } from '../../../../../../shared/git/status/git-status-types'
import type { SourceControlViewMode } from '../../../../../../shared/ui-chrome-types'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { PrimaryAction } from '../review/source-control-primary-action-types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { WorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/git-identity-display'
import {
  HostedReviewToolbarLink,
  CreatePrHeaderButton,
  SuppressedGitHubPRToolbar
} from './header-review-actions'
import { SourceControlBranchContextRow } from './branch-context-row'
import { shouldShowSourceControlBranchContextChrome } from './branch-context-stats'
import { SourceControlHeaderOverflowMenu } from './header-overflow-menu'
import { useSourceControlHeaderActionsSlot } from './header-actions-slot'
import { useSourceControlScope } from './worktree-scope'

type SourceControlHeaderToolbarProps = {
  filterQuery: string
  filterExpanded: boolean
  onFilterQueryChange: (value: string) => void
  onFilterExpandedChange: (expanded: boolean) => void
  visibleCreatePrHeaderAction: PrimaryAction | null
  hostedReview: HostedReviewInfo | null
  isCreatePrIntentInFlight: boolean
  isCreatingPr: boolean
  onCreatePrHeaderClick: () => void
  onOpenHostedReviewInChecks: () => void
  suppressedGitHubPRNumber: number | null
  onRelinkSuppressedGitHubPR: () => void
  sourceControlViewMode: SourceControlViewMode
  viewModeToggleDisabled: boolean
  onToggleViewMode: () => void
  onChangeBaseRef: () => void
  onRefreshBranchCompare: () => void
  branchCompareRefreshDisabled: boolean
  diffCommentCount: number
  onExpandNotes: () => void
  branchSummary: GitBranchCompareSummary | null
  compareBaseRef: string | null
  headControl?: React.ReactNode
  headDisplay?: WorktreeGitIdentityDisplay | null
  manualReviewUrl?: string | null
  branchLineTotal?: GitBranchLineTotal | null
}

function renderOverflowMenu(
  props: Pick<
    SourceControlHeaderToolbarProps,
    | 'sourceControlViewMode'
    | 'viewModeToggleDisabled'
    | 'onToggleViewMode'
    | 'onChangeBaseRef'
    | 'onRefreshBranchCompare'
    | 'branchCompareRefreshDisabled'
    | 'diffCommentCount'
    | 'onExpandNotes'
  >
): React.JSX.Element {
  return <SourceControlHeaderOverflowMenu panelActions={props} />
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
  sourceControlViewMode,
  viewModeToggleDisabled,
  onToggleViewMode,
  onChangeBaseRef,
  onRefreshBranchCompare,
  branchCompareRefreshDisabled,
  diffCommentCount,
  onExpandNotes,
  branchSummary,
  compareBaseRef,
  headDisplay = null,
  headControl,
  manualReviewUrl,
  branchLineTotal
}: SourceControlHeaderToolbarProps): React.JSX.Element {
  const t = useTranslate()
  const embedded = useSourceControlScope() !== null
  const actionsSlot = useSourceControlHeaderActionsSlot()
  const filterInputRef = useRef<HTMLInputElement>(null)
  const normalizedFilter = filterQuery.trim()
  const showCollapsedToolbar = !filterExpanded
  const overflowProps = {
    sourceControlViewMode,
    viewModeToggleDisabled,
    onToggleViewMode,
    onChangeBaseRef,
    onRefreshBranchCompare,
    branchCompareRefreshDisabled,
    diffCommentCount,
    onExpandNotes
  }

  const expandFilter = useCallback(() => {
    onFilterExpandedChange(true)
  }, [onFilterExpandedChange])

  const collapseFilter = useCallback(() => {
    onFilterExpandedChange(false)
  }, [onFilterExpandedChange])

  const clearAndCollapseFilter = useCallback(() => {
    onFilterQueryChange('')
    onFilterExpandedChange(false)
  }, [onFilterExpandedChange, onFilterQueryChange])

  useEffect(() => {
    if (!filterExpanded) {
      return
    }
    filterInputRef.current?.focus()
    filterInputRef.current?.select()
  }, [filterExpanded])

  const filterToggleTitle = normalizedFilter
    ? t('auto.components.right.sidebar.SourceControl.c8e4a1f902', 'Filter: {{value0}}', {
        value0: filterQuery
      })
    : t('auto.components.right.sidebar.SourceControl.b3c8f1a902', 'Filter files by name')

  const reviewControl = hostedReview ? (
    <HostedReviewToolbarLink
      review={hostedReview}
      compact={embedded}
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

  const filterToggle = (
    <button
      type="button"
      data-testid="source-control-filter-toggle"
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        embedded ? 'size-6' : 'size-7',
        (normalizedFilter || (embedded && filterExpanded)) && 'bg-muted text-foreground'
      )}
      onClick={embedded && filterExpanded ? collapseFilter : expandFilter}
      aria-label={filterToggleTitle}
      title={filterToggleTitle}
      aria-expanded={embedded ? filterExpanded : false}
    >
      <Search className="size-3.5" />
      {normalizedFilter ? (
        <span className="absolute right-1 top-1 size-1.5 rounded-full bg-foreground" />
      ) : null}
    </button>
  )

  const filterRow = (
    <>
      {/* Give expanded search the row so PR links and overflow controls do not squeeze typing. */}
      <div className="flex min-w-0 w-full flex-1 items-center gap-1.5">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <ImeInput
          ref={filterInputRef}
          data-testid="source-control-filter-input"
          type="text"
          value={filterQuery}
          onChange={(event) => onFilterQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              collapseFilter()
            }
          }}
          placeholder={t('auto.components.right.sidebar.SourceControl.c35baf2f1e', 'Filter files…')}
          className="min-w-0 w-full flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          aria-label={t('auto.components.right.sidebar.SourceControl.c35baf2f1e', 'Filter files…')}
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
        aria-label={t(
          'auto.components.right.sidebar.SourceControl.d4f8c2a901',
          'Clear and close filter'
        )}
        title={t(
          'auto.components.right.sidebar.SourceControl.d4f8c2a901',
          'Clear and close filter'
        )}
        onClick={clearAndCollapseFilter}
      >
        <X className="size-3.5" />
      </Button>
    </>
  )

  const showBranchContext = shouldShowSourceControlBranchContextChrome(
    branchSummary,
    compareBaseRef,
    headDisplay
  )
  const branchContextRow = (reviewTrailing?: React.ReactNode) => (
    <SourceControlBranchContextRow
      summary={branchSummary}
      compareBaseRef={compareBaseRef}
      headDisplay={headDisplay}
      headControl={headControl}
      manualReviewUrl={manualReviewUrl}
      branchLineTotal={branchLineTotal}
      reviewControl={reviewTrailing}
      onChangeBaseRef={onChangeBaseRef}
      onRetry={onRefreshBranchCompare}
    />
  )

  if (embedded) {
    // The card header owns filter and overflow; the PR control joins the compare row's base line.
    const reviewRowShown = reviewControl !== null && !showBranchContext
    return (
      <>
        {actionsSlot
          ? createPortal(
              <>
                {filterToggle}
                {renderOverflowMenu(overflowProps)}
              </>,
              actionsSlot
            )
          : null}
        {filterExpanded || showBranchContext || reviewRowShown ? (
          <div className="flex flex-col gap-1 border-b border-border px-3 py-1.5">
            {filterExpanded ? (
              <div className="mb-1.5 flex min-w-0 items-center gap-1.5 border-b border-border pb-1.5">
                {filterRow}
              </div>
            ) : null}
            {showBranchContext ? branchContextRow(reviewControl) : null}
            {reviewRowShown ? (
              <div className="flex min-w-0 items-center">{reviewControl}</div>
            ) : null}
          </div>
        ) : null}
      </>
    )
  }

  return (
    <div className="border-b border-border px-3 pt-1.5 pb-1">
      <div
        className={cn('flex min-w-0 items-center gap-1', filterExpanded && 'w-full gap-1.5')}
        data-filter-expanded={filterExpanded ? 'true' : 'false'}
      >
        {showCollapsedToolbar ? (
          <>
            {reviewControl ?? <span className="min-w-0 flex-1" aria-hidden="true" />}
            {(visibleCreatePrHeaderAction || suppressedGitHubPRNumber !== null) && !hostedReview ? (
              // Pin filter/overflow right without stretching Create PR.
              <span className="min-w-0 flex-1" aria-hidden="true" />
            ) : null}
            {filterToggle}
            {renderOverflowMenu(overflowProps)}
          </>
        ) : (
          filterRow
        )}
      </div>

      {showBranchContext ? <div className="mt-1">{branchContextRow()}</div> : null}
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
