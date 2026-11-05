import React from 'react'
import { HardDrive, Loader2, RotateCcw, Search, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ScrollArea } from '@/components/ui/scroll-area'
import { translate } from '@/i18n/i18n'
import {
  useAppliedWorkspaceCleanupFilters,
  WorkspaceCleanupAppliedFilterChips
} from './workspace-cleanup-applied-filter-chips'
import type { WorkspaceCleanupAppliedFilter } from '../../../../shared/workspace-cleanup/workspace-cleanup-applied-filters'
import { WorkspaceCleanupGitReviewFacets } from './workspace-cleanup-git-review-facets'
import { WorkspaceCleanupLifecycleFacets } from './workspace-cleanup-lifecycle-facets'
import type { WorkspaceCleanupFacetGroupProps } from './workspace-cleanup-facet-panel-model'

export type WorkspaceCleanupGitEvidenceProgress = {
  pendingCount: number
  totalCount: number
}

/** Present while sizes are unmeasured or a scan runs; the button is the one way to fill sizes. */
export type WorkspaceCleanupSizeScanAction = {
  scanning: boolean
  scannedCount: number
  totalCount: number
  onRun: () => void
}

export function WorkspaceCleanupFilterBar({
  facetProps,
  facetPanelOpen,
  onFacetPanelOpenChange,
  activeFacetGroupCount,
  matchedCount,
  hasActiveFilters,
  gitEvidence,
  sizeScan,
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
  sizeScan: WorkspaceCleanupSizeScanAction | null
  onQueryChange: (query: string) => void
  onClearFilters: () => void
  onClearAppliedFilter: (filter: WorkspaceCleanupAppliedFilter) => void
}): React.JSX.Element {
  const { filters, totalCount } = facetProps
  const applied = useAppliedWorkspaceCleanupFilters(filters)
  const filtersLabel = translate('components.workspace.cleanup.browse.filters', 'Filters')
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
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
          adornment="trailing"
          className="h-8 pl-8 text-xs"
        />
        {/* Filters live inside the search field: both narrow the same list. */}
        <Popover modal={false} open={facetPanelOpen} onOpenChange={onFacetPanelOpenChange}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={filtersLabel}
                  className="absolute top-1/2 right-1 -translate-y-1/2"
                >
                  <SlidersHorizontal className="size-3.5" />
                  {activeFacetGroupCount > 0 ? (
                    <span className="tabular-nums">{activeFacetGroupCount}</span>
                  ) : null}
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {filtersLabel}
            </TooltipContent>
          </Tooltip>
          <PopoverContent
            align="end"
            sideOffset={6}
            // Portaled content needs the wheel shim for Radix scroll-lock, but not popover-scroll-content’s max-height, which would crush the facet column.
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
              <Button
                variant="ghost"
                size="sm"
                disabled={!hasActiveFilters}
                onClick={onClearFilters}
              >
                <RotateCcw className="size-3.5" />
                {translate('components.workspace.cleanup.browse.clearFilters', 'Clear filters')}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {sizeScan ? <SizeScanButton {...sizeScan} /> : null}

      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1 text-xs tabular-nums text-muted-foreground">
        <GitCheckIndicator pendingCount={gitEvidence.pendingCount} />
        {hasActiveFilters
          ? translate(
              'components.workspace.cleanup.browse.showingCount',
              'Showing {{value0}} of {{value1}}',
              { value0: matchedCount, value1: totalCount }
            )
          : translate(
              'components.workspace.cleanup.browse.workspaceCount',
              '{{count}} workspaces',
              {
                count: totalCount,
                defaultValue_one: '{{count}} workspace'
              }
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

      <WorkspaceCleanupAppliedFilterChips applied={applied} onClear={onClearAppliedFilter} />
    </div>
  )
}

function SizeScanButton({
  scanning,
  scannedCount,
  totalCount,
  onRun
}: WorkspaceCleanupSizeScanAction): React.JSX.Element {
  const idleLabel = translate(
    'components.workspace.cleanup.browse.measureSizesTitle',
    'Scan workspace sizes'
  )
  const label = !scanning
    ? idleLabel
    : totalCount > 0
      ? translate(
          'components.workspace.cleanup.browse.measuringSizesProgress',
          'Scanning {{value0}}/{{value1}}',
          { value0: scannedCount, value1: totalCount }
        )
      : translate('components.workspace.cleanup.browse.measuringSizes', 'Scanning sizes')
  return (
    <Button variant="outline" size="sm" className="shrink-0" disabled={scanning} onClick={onRun}>
      {scanning ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <HardDrive className="size-3.5" />
      )}
      {/* Stack the idle label under the live one so the button never changes width. */}
      <span className="grid tabular-nums">
        <span className="invisible col-start-1 row-start-1" aria-hidden="true">
          {idleLabel}
        </span>
        <span className="col-start-1 row-start-1">{label}</span>
      </span>
    </Button>
  )
}

// Reserve the spinner's slot so the count beside it stays put while git checks finish.
function GitCheckIndicator({ pendingCount }: { pendingCount: number }): React.JSX.Element {
  if (pendingCount === 0) {
    return <span className="size-3.5" aria-hidden="true" />
  }
  const label = translate(
    'components.workspace.cleanup.browse.checkingGit',
    'Checking git status: {{value0}} left',
    { value0: pendingCount }
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="status" aria-label={label} className="flex">
          <Loader2 className="size-3.5 animate-spin" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
