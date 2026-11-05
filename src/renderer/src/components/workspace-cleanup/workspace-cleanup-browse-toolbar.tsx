import React from 'react'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupBrowseController } from './use-workspace-cleanup-browse-state'
import type { WorkspaceCleanupFacetRows } from './use-workspace-cleanup-facet-rows'
import { listActiveWorkspaceCleanupFacetGroups } from './workspace-cleanup-active-facets'
import { WorkspaceCleanupEmptyState } from './workspace-cleanup-dialog-notices'
import { WorkspaceCleanupFilterBar } from './workspace-cleanup-filter-bar'
import { WorkspaceCleanupSortHeader } from './workspace-cleanup-sort-header'
import type { WorkspaceSpaceScanProgress } from '../../../../shared/workspace-disk-space/workspace-space-types'

export function WorkspaceCleanupBrowseToolbar({
  browse,
  facetRows,
  facetPanelOpen,
  onFacetPanelOpenChange,
  selectableCount,
  selectedSelectableCount,
  selectedCount,
  deleteDisabled,
  spaceScanning,
  spaceProgress,
  gitPendingCount,
  gitCheckedTotal,
  onRunSpaceScan,
  onToggleSelectAll,
  onDeleteSelected
}: {
  browse: WorkspaceCleanupBrowseController
  facetRows: WorkspaceCleanupFacetRows
  facetPanelOpen: boolean
  onFacetPanelOpenChange: (open: boolean) => void
  selectableCount: number
  selectedSelectableCount: number
  selectedCount: number
  deleteDisabled: boolean
  spaceScanning: boolean
  spaceProgress: WorkspaceSpaceScanProgress | null
  gitPendingCount: number
  gitCheckedTotal: number
  onRunSpaceScan: () => void
  onToggleSelectAll: (selectAll: boolean) => void
  onDeleteSelected: () => void
}): React.JSX.Element {
  // Filter-group comparisons must ignore keystroke/stream rerenders until filters themselves change.
  const activeFacetGroupCount = React.useMemo(
    () => listActiveWorkspaceCleanupFacetGroups(browse.filters).length,
    [browse.filters]
  )
  const activeFilters = browse.filters.query.trim().length > 0 || activeFacetGroupCount > 0
  return (
    <>
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
        matchedCount={facetRows.matchedCount}
        hasActiveFilters={activeFilters}
        gitEvidence={{ pendingCount: gitPendingCount, totalCount: gitCheckedTotal }}
        sizeScan={
          spaceScanning || facetRows.unmeasuredSizeCount > 0
            ? {
                scanning: spaceScanning,
                scannedCount: spaceProgress?.scannedWorktreeCount ?? 0,
                totalCount: spaceProgress?.totalWorktreeCount ?? 0,
                onRun: onRunSpaceScan
              }
            : null
        }
        onQueryChange={(query) => browse.patchFilters('query', query)}
        onClearFilters={browse.clearFilters}
        onClearAppliedFilter={(filter) => browse.replaceFilters(filter.clear)}
      />
      <WorkspaceCleanupSortHeader
        sort={browse.sort}
        selectableCount={selectableCount}
        selectedSelectableCount={selectedSelectableCount}
        selectedCount={selectedCount}
        deleteDisabled={deleteDisabled}
        onToggleSortField={browse.toggleSortField}
        onToggleSelectAll={onToggleSelectAll}
        onDeleteSelected={onDeleteSelected}
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
