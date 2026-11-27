import { useMemo } from 'react'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import type {
  WorkspaceCleanupFilterState,
  WorkspaceCleanupSortState
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-filter-model'
import { getSelectedDeletableCandidates } from '../browse/workspace-cleanup-selection-model'
import type { WorkspaceCleanupGitEvidenceState } from '../candidate-evidence/use-workspace-cleanup-git-evidence'
import { useWorkspaceCleanupHeldRows } from '../candidate-list/use-workspace-cleanup-row-order'
import type { WorkspaceCleanupFacets } from '../query/workspace-cleanup-facets'
import { useWorkspaceCleanupGroupedRows } from './use-workspace-cleanup-grouped-rows'

/**
 * The pick step's rows: the held order over the filtered rows, split into the group cards,
 * plus the selected rows confirm would delete (live data, limited to what a card shows).
 */
export function useWorkspaceCleanupPickRows({
  liveRows,
  allRows,
  sort,
  filters,
  candidates,
  open,
  loading,
  gitEvidence,
  selectedIds,
  deletingIdentities,
  shouldResortAtSettle
}: {
  /** Rows matching the active filters, in the active sort. */
  liveRows: readonly WorkspaceCleanupFacets[]
  /** Every row, unfiltered. */
  allRows: readonly WorkspaceCleanupFacets[]
  sort: WorkspaceCleanupSortState
  filters: WorkspaceCleanupFilterState
  candidates: readonly WorkspaceCleanupCandidate[]
  open: boolean
  loading: boolean
  gitEvidence: Pick<WorkspaceCleanupGitEvidenceState, 'pendingWorktreeIds' | 'totalCount'>
  selectedIds: ReadonlySet<string>
  deletingIdentities: ReadonlySet<string>
  shouldResortAtSettle: () => boolean
}) {
  const liveRowByIdentity = useMemo(
    () => new Map(allRows.map((row) => [row.identity, row])),
    [allRows]
  )
  const filterKey = JSON.stringify(filters)
  const { rows, releaseRows } = useWorkspaceCleanupHeldRows({
    liveRows,
    liveRowByIdentity,
    resetKey: `${sort.field}:${sort.direction}:${filterKey}`,
    filterKey,
    open,
    loading,
    gitChecking: gitEvidence.pendingWorktreeIds.size > 0,
    // Selected rows are never hidden: a Refresh or sort-only reset keeps them in place even if
    // late evidence made them stop matching. Only the user's own filter change prunes them.
    pinnedIdentities: selectedIds,
    shouldResortAtSettle
  })
  const grouped = useWorkspaceCleanupGroupedRows({
    rows,
    candidates,
    open,
    scanning: loading,
    gitEvidence,
    selectedIds,
    deletingIdentities
  })
  const { visibleIdentities } = grouped
  const selectedCandidates = useMemo(
    () =>
      getSelectedDeletableCandidates(
        rows.filter((row) => visibleIdentities.has(row.identity)),
        selectedIds,
        deletingIdentities
      ),
    [deletingIdentities, rows, selectedIds, visibleIdentities]
  )
  return { ...grouped, releaseRows, selectedCandidates }
}
