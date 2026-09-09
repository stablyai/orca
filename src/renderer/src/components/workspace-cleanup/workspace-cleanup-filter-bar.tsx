import React from 'react'
import { Loader2, RotateCcw, Search, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { translate } from '@/i18n/i18n'
import {
  useAppliedWorkspaceCleanupFilters,
  WorkspaceCleanupAppliedFilterChips
} from './workspace-cleanup-applied-filter-chips'
import type { WorkspaceCleanupAppliedFilter } from '../../../../shared/workspace-cleanup-applied-filters'
import { WorkspaceCleanupGitReviewFacets } from './workspace-cleanup-git-review-facets'
import { WorkspaceCleanupLifecycleFacets } from './workspace-cleanup-lifecycle-facets'
import type { WorkspaceCleanupFacetGroupProps } from './workspace-cleanup-facet-panel-model'

export type WorkspaceCleanupGitEvidenceProgress = {
  pendingCount: number
  totalCount: number
}

export function WorkspaceCleanupFilterBar({
  facetProps,
  facetPanelOpen,
  onFacetPanelOpenChange,
  activeFacetGroupCount,
  matchedCount,
  hasActiveFilters,
  gitEvidence,
  onQueryChange,
  onClearFilters,
  onClearAppliedFilter
}: {
  facetProps: WorkspaceCleanupFacetGroupProps
  facetPanelOpen: boolean
  onFacetPanelOpenChange: (open: boolean) => void
  activeFacetGroupCount: number
  matchedCount: number
  hasActiveFilters: boolean
  gitEvidence: WorkspaceCleanupGitEvidenceProgress
  onQueryChange: (query: string) => void
  onClearFilters: () => void
  onClearAppliedFilter: (filter: WorkspaceCleanupAppliedFilter) => void
}): React.JSX.Element {
  const { filters, totalCount } = facetProps
  const applied = useAppliedWorkspaceCleanupFilters(filters)
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/15 px-3 py-2">
      <div className="relative min-w-[180px] flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={translate(
            'components.workspace.cleanup.browse.searchPlaceholder',
            'Search name, repo, branch, path, host'
          )}
          aria-label={translate(
            'components.workspace.cleanup.browse.searchLabel',
            'Search workspaces'
          )}
          className="h-8 pl-8 text-xs"
        />
      </div>

      <Popover modal={false} open={facetPanelOpen} onOpenChange={onFacetPanelOpenChange}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="shrink-0">
            <SlidersHorizontal className="size-3.5" />
            {translate('components.workspace.cleanup.browse.filters', 'Filters')}
            {activeFacetGroupCount > 0 ? (
              <span className="ml-1 rounded-full bg-accent px-1.5 text-[11px] tabular-nums text-accent-foreground">
                {activeFacetGroupCount}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          sideOffset={6}
          // Why popover-wheel-scroll and not popover-scroll-content: this popover portals
          // outside the dialog subtree, so react-remove-scroll cancels wheel here and only
          // the scrollbar drag worked. It needs the shim but not the styling half --
          // popover-scroll-content caps height at 15rem, which would crush this panel's
          // 471px flex column.
          className="popover-wheel-scroll flex h-[min(471px,var(--radix-popover-content-available-height))] w-[320px] flex-col p-0"
        >
          {/* 471px preserves the 420px facet viewport plus the fixed footer at full height. */}
          <ScrollArea className="min-h-0 flex-1">
            <WorkspaceCleanupLifecycleFacets {...facetProps} />
            <WorkspaceCleanupGitReviewFacets {...facetProps} />
          </ScrollArea>
          <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
            <span className="text-[11px] text-muted-foreground">
              {translate(
                'components.workspace.cleanup.browse.showingCount',
                'Showing {{value0}} of {{value1}}',
                { value0: matchedCount, value1: totalCount }
              )}
            </span>
            <Button variant="ghost" size="sm" disabled={!hasActiveFilters} onClick={onClearFilters}>
              <RotateCcw className="size-3.5" />
              {translate('components.workspace.cleanup.browse.clearFilters', 'Clear filters')}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {translate(
          'components.workspace.cleanup.browse.showingCount',
          'Showing {{value0}} of {{value1}}',
          { value0: matchedCount, value1: totalCount }
        )}
      </span>

      {/* Why out here and not only in the popover: a filter narrowing the list must be
          clearable without first discovering which panel it lives in. */}
      {hasActiveFilters ? (
        <Button variant="ghost" size="sm" className="shrink-0" onClick={onClearFilters}>
          <RotateCcw className="size-3.5" />
          {translate('components.workspace.cleanup.browse.clearFilters', 'Clear filters')}
        </Button>
      ) : null}

      {gitEvidence.pendingCount > 0 ? (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {translate(
            'components.workspace.cleanup.browse.checkingGit',
            'Checking git status: {{value0}} left',
            { value0: gitEvidence.pendingCount }
          )}
        </span>
      ) : null}

      <WorkspaceCleanupAppliedFilterChips applied={applied} onClear={onClearAppliedFilter} />
    </div>
  )
}
