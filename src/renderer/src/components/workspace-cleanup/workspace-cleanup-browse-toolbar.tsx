import React from 'react'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupBrowseController } from './use-workspace-cleanup-browse-state'
import type { WorkspaceCleanupFacetRows } from './use-workspace-cleanup-facet-rows'
import { listActiveWorkspaceCleanupFacetGroups } from './workspace-cleanup-active-facets'
import {
  WorkspaceCleanupEmptyState,
  WorkspaceCleanupSizeScanBanner
} from './workspace-cleanup-dialog-notices'
import { WorkspaceCleanupFilterBar } from './workspace-cleanup-filter-bar'
import { WorkspaceCleanupSortHeader } from './workspace-cleanup-sort-header'
import type { WorkspaceSpaceScanProgress } from '../../../../shared/workspace-space-types'

export function WorkspaceCleanupBrowseToolbar({
  browse,
  facetRows,
  facetPanelOpen,
  onFacetPanelOpenChange,
  selectableCount,
  selectedCount,
  spaceScanning,
  spaceProgress,
  gitPendingCount,
  gitCheckedTotal,
  onRunSpaceScan,
  onToggleSelectAll
}: {
  browse: WorkspaceCleanupBrowseController
  facetRows: WorkspaceCleanupFacetRows
  facetPanelOpen: boolean
  onFacetPanelOpenChange: (open: boolean) => void
  selectableCount: number
  selectedCount: number
  spaceScanning: boolean
  spaceProgress: WorkspaceSpaceScanProgress | null
  gitPendingCount: number
  gitCheckedTotal: number
  onRunSpaceScan: () => void
  onToggleSelectAll: (selectAll: boolean) => void
}): React.JSX.Element {
  // Why: this toolbar re-renders per keystroke and per streaming tick; the
  // group comparisons must not rerun unless the filter state itself changed.
  const activeFacetGroupCount = React.useMemo(
    () => listActiveWorkspaceCleanupFacetGroups(browse.filters).length,
    [browse.filters]
  )
  const activeFilters = browse.filters.query.trim().length > 0 || activeFacetGroupCount > 0
  return (
    <>
      {spaceScanning || facetRows.unmeasuredSizeCount > 0 ? (
        <WorkspaceCleanupSizeScanBanner
          scanning={spaceScanning}
          scannedCount={spaceProgress?.scannedWorktreeCount ?? 0}
          totalCount={spaceProgress?.totalWorktreeCount ?? 0}
          onRun={onRunSpaceScan}
        />
      ) : null}
      <WorkspaceCleanupFilterBar
        facetProps={{
          filters: browse.filters,
          counts: facetRows.facetCounts,
          totalCount: facetRows.totalCount,
          options: facetRows.options,
          onPatch: browse.patchFilters
        }}
        facetPanelOpen={facetPanelOpen}
        onFacetPanelOpenChange={onFacetPanelOpenChange}
        activeFacetGroupCount={activeFacetGroupCount}
        matchedCount={facetRows.matchedCount}
        hasActiveFilters={activeFilters}
        gitEvidence={{ pendingCount: gitPendingCount, totalCount: gitCheckedTotal }}
        onQueryChange={(query) => browse.patchFilters('query', query)}
        onClearFilters={browse.clearFilters}
        onClearAppliedFilter={(filter) => browse.replaceFilters(filter.clear)}
      />
      <WorkspaceCleanupSortHeader
        sort={browse.sort}
        selectableCount={selectableCount}
        selectedCount={selectedCount}
        onToggleSortField={browse.toggleSortField}
        onToggleSelectAll={onToggleSelectAll}
      />
      {browse.sort.field === 'size' && facetRows.measuredSizeCount === 0 && !spaceScanning ? (
        <WorkspaceCleanupEmptyState
          title={translate(
            'components.workspace.cleanup.browse.noSizes',
            'No workspace sizes measured yet.'
          )}
          description={translate(
            'components.workspace.cleanup.browse.noSizesDescription',
            'Sizes appear after disk usage has been measured.'
          )}
        />
      ) : null}
    </>
  )
}
