import { useCallback, useMemo } from 'react'
import {
  canQueueWorkspaceCleanupCandidate,
  type WorkspaceCleanupCandidate
} from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import {
  getWorkspaceCleanupGroup,
  WORKSPACE_CLEANUP_GROUPS,
  type WorkspaceCleanupGroup
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-groups'
import { hasWorkspaceCleanupGitEvidence } from '../candidate-evidence/workspace-cleanup-git-evidence'
import type { WorkspaceCleanupGitEvidenceState } from '../candidate-evidence/use-workspace-cleanup-git-evidence'
import type { WorkspaceCleanupFacets } from '../query/workspace-cleanup-facets'
import type { WorkspaceCleanupGroupSummary } from './workspace-cleanup-group-cards'
import { useWorkspaceCleanupFrozenGroups } from './workspace-cleanup-frozen-groups'

/** Splits the held rows into the three cards, counting what the user ticked in each. */
export function useWorkspaceCleanupGroupedRows({
  rows,
  candidates,
  open,
  scanning,
  gitEvidence,
  selectedIds,
  deletingIdentities
}: {
  rows: readonly WorkspaceCleanupFacets[]
  candidates: readonly WorkspaceCleanupCandidate[]
  open: boolean
  scanning: boolean
  gitEvidence: Pick<WorkspaceCleanupGitEvidenceState, 'pendingWorktreeIds' | 'totalCount'>
  selectedIds: ReadonlySet<string>
  deletingIdentities: ReadonlySet<string>
}): {
  rowsByGroup: Record<WorkspaceCleanupGroup, readonly WorkspaceCleanupFacets[]>
  groupSummaries: Record<WorkspaceCleanupGroup, WorkspaceCleanupGroupSummary>
  getRowGroup: (row: { candidate: WorkspaceCleanupCandidate }) => WorkspaceCleanupGroup
  resetGroups: () => void
  /** Rows still waiting on a git answer; they sit in no card yet. */
  uncheckedCount: number
  updatesAvailable: boolean
  /** Rows shown in some card; a selection only counts and deletes what is visible. */
  visibleIdentities: ReadonlySet<string>
} {
  const { getFrozenGroup, resetGroups, updatesAvailable } = useWorkspaceCleanupFrozenGroups({
    candidates,
    open,
    scanning,
    gitPendingWorktreeIds: gitEvidence.pendingWorktreeIds,
    // The reader queues in a layout effect, after this render's pending set was read.
    gitChecksStarted:
      gitEvidence.totalCount > 0 ||
      !candidates.some((candidate) => hasWorkspaceCleanupGitEvidence(candidate) === false),
    selectedIds
  })
  const grouped = useMemo(() => {
    const byGroup: Record<WorkspaceCleanupGroup, { row: WorkspaceCleanupFacets; batch: number }[]> =
      { 'nothing-local': [], 'local-files': [], 'cannot-delete': [] }
    let unchecked = 0
    for (const row of rows) {
      const frozen = getFrozenGroup(row.candidate)
      if (frozen) {
        // Show the row as first admitted; live data waits for Refresh and the confirm step.
        byGroup[frozen.group].push({
          row: getDisplayRow(row, frozen.candidate),
          batch: frozen.batch
        })
      } else {
        unchecked += 1
      }
    }
    // Rows admitted later list after earlier ones; within a pass the held order stands.
    const sorted = mapWorkspaceCleanupGroups((group) =>
      byGroup[group].sort((a, b) => a.batch - b.batch).map((entry) => entry.row)
    )
    const visible = new Set<string>()
    for (const group of WORKSPACE_CLEANUP_GROUPS) {
      sorted[group].forEach((row) => visible.add(row.identity))
    }
    return { byGroup: sorted, unchecked, visible }
  }, [getFrozenGroup, rows])
  const rowsByGroup = grouped.byGroup
  const groupSummaries = useMemo(() => {
    return mapWorkspaceCleanupGroups((group) => {
      const groupRows = rowsByGroup[group]
      return {
        count: groupRows.length,
        selectedCount: groupRows.filter(
          (row) => selectedIds.has(row.identity) && !deletingIdentities.has(row.identity)
        ).length
      }
    })
  }, [deletingIdentities, rowsByGroup, selectedIds])
  const getRowGroup = useCallback(
    (row: { candidate: WorkspaceCleanupCandidate }) =>
      canQueueWorkspaceCleanupCandidate(row.candidate)
        ? (getFrozenGroup(row.candidate)?.group ?? getWorkspaceCleanupGroup(row.candidate))
        : 'cannot-delete',
    [getFrozenGroup]
  )
  return {
    rowsByGroup,
    groupSummaries,
    getRowGroup,
    resetGroups,
    uncheckedCount: grouped.unchecked,
    updatesAvailable,
    visibleIdentities: grouped.visible
  }
}

function mapWorkspaceCleanupGroups<T>(
  build: (group: WorkspaceCleanupGroup) => T
): Record<WorkspaceCleanupGroup, T> {
  return {
    'nothing-local': build('nothing-local'),
    'local-files': build('local-files'),
    'cannot-delete': build('cannot-delete')
  }
}

/** Shows the admitted snapshot; a row that can no longer be queued shows live, so its lock and reason appear at once. */
function getDisplayRow(
  row: WorkspaceCleanupFacets,
  snapshot: WorkspaceCleanupCandidate
): WorkspaceCleanupFacets {
  if (!canQueueWorkspaceCleanupCandidate(row.candidate) || row.candidate === snapshot) {
    return row
  }
  return { ...row, candidate: snapshot }
}
