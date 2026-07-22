import React, { useCallback, useEffect, useRef } from 'react'
import { GitBranch, Search, X } from 'lucide-react'
import type {
  GitBranchCompareSummary,
  GitUpstreamStatus,
  SourceControlViewMode
} from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { DetachedHeadBadge } from '@/components/DetachedHeadBadge'
import type { WorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import {
  shouldShowSourceControlBranchContextRow,
  SourceControlBranchContextRow
} from './source-control-branch-context-row'
import { SourceControlHeaderOverflowMenu } from './source-control-header-overflow-menu'

type SourceControlHeaderToolbarProps = {
  gitIdentityDisplay: WorktreeGitIdentityDisplay | null
  filterQuery: string
  filterExpanded: boolean
  onFilterQueryChange: (value: string) => void
  onFilterExpandedChange: (expanded: boolean) => void
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
  upstreamStatus?: GitUpstreamStatus
  manualReviewUrl?: string | null
}

function SourceControlGitIdentityLabel({
  display
}: {
  display: WorktreeGitIdentityDisplay
}): React.JSX.Element {
  if (display.kind === 'detached') {
    return (
      <span className="flex min-w-0 flex-1 items-center">
        <DetachedHeadBadge
          display={display}
          side="bottom"
          className="min-w-0 max-w-full shrink"
          tabIndex={0}
        />
      </span>
    )
  }

  const branchName = display.branchName
  const label = translate(
    'auto.components.right.sidebar.SourceControl.a4e93c21d7',
    'Current branch: {{value0}}',
    { value0: branchName }
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex min-w-0 flex-1 items-center gap-1 rounded-sm font-mono text-xs font-medium leading-none text-foreground/90 outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={label}
          tabIndex={0}
        >
          <GitBranch className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 truncate">{branchName}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="max-w-72 break-all font-mono">
        {branchName}
      </TooltipContent>
    </Tooltip>
  )
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
  return <SourceControlHeaderOverflowMenu {...props} />
}

export function SourceControlHeaderToolbar({
  gitIdentityDisplay,
  filterQuery,
  filterExpanded,
  onFilterQueryChange,
  onFilterExpandedChange,
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
  upstreamStatus,
  manualReviewUrl
}: SourceControlHeaderToolbarProps): React.JSX.Element {
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
    ? translate('auto.components.right.sidebar.SourceControl.c8e4a1f902', 'Filter: {{value0}}', {
        value0: filterQuery
      })
    : translate('auto.components.right.sidebar.SourceControl.b3c8f1a902', 'Filter files by name')

  return (
    <div className="border-b border-border px-3 pt-1.5 pb-1">
      <div
        className={cn('flex min-w-0 items-center gap-1', filterExpanded && 'w-full gap-1.5')}
        data-filter-expanded={filterExpanded ? 'true' : 'false'}
      >
        {showCollapsedToolbar ? (
          <>
            {gitIdentityDisplay ? (
              <SourceControlGitIdentityLabel display={gitIdentityDisplay} />
            ) : (
              <span className="min-w-0 flex-1" aria-hidden="true" />
            )}
            <button
              type="button"
              data-testid="source-control-filter-toggle"
              className={cn(
                'relative inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                normalizedFilter && 'bg-muted text-foreground'
              )}
              onClick={expandFilter}
              aria-label={filterToggleTitle}
              title={filterToggleTitle}
              aria-expanded={false}
            >
              <Search className="size-3.5" />
              {normalizedFilter ? (
                <span className="absolute right-1 top-1 size-1.5 rounded-full bg-foreground" />
              ) : null}
            </button>
            {renderOverflowMenu(overflowProps)}
          </>
        ) : (
          <>
            {/* Why: expanded filter owns the toolbar row so typing isn't squeezed
                beside branch identity or header actions — collapse to reach those. */}
            <div className="flex min-w-0 w-full flex-1 items-center gap-1.5">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
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
                placeholder={translate(
                  'auto.components.right.sidebar.SourceControl.c35baf2f1e',
                  'Filter files…'
                )}
                className="min-w-0 w-full flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
                aria-label={translate(
                  'auto.components.right.sidebar.SourceControl.c35baf2f1e',
                  'Filter files…'
                )}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label={translate(
                'auto.components.right.sidebar.SourceControl.d4f8c2a901',
                'Clear and close filter'
              )}
              title={translate(
                'auto.components.right.sidebar.SourceControl.d4f8c2a901',
                'Clear and close filter'
              )}
              onClick={clearAndCollapseFilter}
            >
              <X className="size-3.5" />
            </Button>
          </>
        )}
      </div>

      {shouldShowSourceControlBranchContextRow(branchSummary, compareBaseRef) ? (
        <div className="mt-1">
          <SourceControlBranchContextRow
            summary={branchSummary}
            compareBaseRef={compareBaseRef}
            upstreamStatus={upstreamStatus}
            manualReviewUrl={manualReviewUrl}
            onChangeBaseRef={onChangeBaseRef}
            onRetry={onRefreshBranchCompare}
          />
        </div>
      ) : null}
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
