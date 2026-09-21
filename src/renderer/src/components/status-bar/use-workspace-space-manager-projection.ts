import { useCallback, useEffect, useMemo } from 'react'
import {
  filterWorkspaceSpaceRows,
  getLargestWorkspaceSpaceRowSize,
  isWorkspaceSpaceRowReadyToDelete,
  pruneWorkspaceSpaceSelectedIds,
  resolveWorkspaceSpaceInspectedWorktreeId,
  resolveWorkspaceSpaceTreemapZoomWorktreeId,
  sortWorkspaceSpaceRows
} from './workspace-space-presentation'
import { getWorkspaceSpaceGitStatusRefreshCandidates } from './workspace-space-git-status-order'
import {
  getSelectedDeletableWorkspaceRows,
  getVisibleDeletableWorkspaceIdentities,
  getWorkspaceSpaceWorktreeIdentity
} from './workspace-space-delete-selection'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import { getWorkspaceSpaceProgressLabel } from './workspace-space-format'
import type { useWorkspaceSpaceManagerBindings } from './use-workspace-space-manager-bindings'
import type { useWorkspaceSpaceDecisionProjection } from './use-workspace-space-decision-projection'
import type { useWorkspaceSpaceGitRefreshAction } from './use-workspace-space-git-refresh-action'

const GIT_STATUS_REFRESH_CONCURRENCY = 6
type WorkspaceSpaceManagerBindings = ReturnType<typeof useWorkspaceSpaceManagerBindings>
type WorkspaceSpaceDecisionProjection = ReturnType<typeof useWorkspaceSpaceDecisionProjection>

export function useWorkspaceSpaceManagerProjection(args: {
  bindings: WorkspaceSpaceManagerBindings
  decision: WorkspaceSpaceDecisionProjection
  refreshWorkspaceGitStatus: ReturnType<typeof useWorkspaceSpaceGitRefreshAction>
}) {
  const {
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    analysis,
    inspectedWorktreeId,
    isScanning,
    onlyDeletable,
    progress,
    query,
    selectedIds,
    gitStatusScanGenerationRef,
    gitStatusByWorktreeIdentityRef,
    inFlightGitStatusRefreshes,
    setGitStatusByWorktreeIdentity,
    setGitRefreshStateByWorktreeId,
    setInspectedWorktreeId,
    setSelectedIds,
    setTreemapZoomWorktreeId,
    sortDirection,
    sortKey,
    treemapZoomWorktreeId
  } = args.bindings
  const { decisionDetailsByWorktreeId, isWorktreeDeleting, sourceRows } = args.decision
  const refreshWorkspaceGitStatus = args.refreshWorkspaceGitStatus

  const isWorktreeUnavailableForDelete = useCallback(
    (worktree: WorkspaceSpaceWorktree): boolean => {
      if (isWorktreeDeleting(worktree)) {
        return true
      }
      return !isWorkspaceSpaceRowReadyToDelete(
        worktree,
        decisionDetailsByWorktreeId.get(getWorkspaceSpaceWorktreeIdentity(worktree))
      )
    },
    [decisionDetailsByWorktreeId, isWorktreeDeleting]
  )

  const rows = useMemo(
    () =>
      sortWorkspaceSpaceRows(
        filterWorkspaceSpaceRows(sourceRows, query, onlyDeletable),
        sortKey,
        sortDirection
      ),
    [onlyDeletable, query, sortDirection, sortKey, sourceRows]
  )

  const nextInspectedWorktreeId = resolveWorkspaceSpaceInspectedWorktreeId(
    sourceRows,
    inspectedWorktreeId
  )
  const nextSelectedIds = pruneWorkspaceSpaceSelectedIds(sourceRows, selectedIds)
  const nextTreemapZoomWorktreeId = resolveWorkspaceSpaceTreemapZoomWorktreeId(
    sourceRows,
    treemapZoomWorktreeId
  )
  // Why: these ids are local UI state derived from the latest scan rows. Repair
  // them before commit so stale selections cannot flash after a scan changes.
  if (inspectedWorktreeId !== nextInspectedWorktreeId) {
    // react-doctor-disable-next-line react-doctor/no-prop-callback-in-render
    setInspectedWorktreeId(nextInspectedWorktreeId)
  }
  if (nextSelectedIds !== selectedIds) {
    // react-doctor-disable-next-line react-doctor/no-prop-callback-in-render
    setSelectedIds(nextSelectedIds)
  }
  if (treemapZoomWorktreeId !== nextTreemapZoomWorktreeId) {
    // react-doctor-disable-next-line react-doctor/no-prop-callback-in-render
    setTreemapZoomWorktreeId(nextTreemapZoomWorktreeId)
  }

  const scanGeneration = analysis?.scannedAt ?? null
  useEffect(() => {
    if (gitStatusScanGenerationRef.current === scanGeneration) {
      return
    }
    gitStatusScanGenerationRef.current = scanGeneration
    gitStatusByWorktreeIdentityRef.current = new Map()
    inFlightGitStatusRefreshes.current.clear()
    setGitStatusByWorktreeIdentity(new Map())
    setGitRefreshStateByWorktreeId({})
  }, [
    analysis?.scannedAt,
    gitStatusByWorktreeIdentityRef,
    gitStatusScanGenerationRef,
    inFlightGitStatusRefreshes,
    scanGeneration,
    setGitRefreshStateByWorktreeId,
    setGitStatusByWorktreeIdentity
  ])

  useEffect(() => {
    const visibleWorktreeIdentities = new Set(rows.map(getWorkspaceSpaceWorktreeIdentity))
    const candidates = getWorkspaceSpaceGitStatusRefreshCandidates(sourceRows, {
      activeWorktreeId,
      activeExecutionHostId: activeWorkspaceExecutionHostId,
      visibleWorktreeIdentities
    })
    if (candidates.length === 0) {
      return
    }

    let cancelled = false
    let nextIndex = 0
    const runWorker = async (): Promise<void> => {
      while (!cancelled) {
        const worktree = candidates[nextIndex]
        nextIndex += 1
        if (!worktree) {
          return
        }
        await refreshWorkspaceGitStatus(worktree)
      }
    }
    const workerCount = Math.min(GIT_STATUS_REFRESH_CONCURRENCY, candidates.length)
    void Promise.all(Array.from({ length: workerCount }, () => runWorker()))

    return () => {
      cancelled = true
    }
  }, [
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    refreshWorkspaceGitStatus,
    rows,
    sourceRows
  ])

  const inspectedWorktree =
    rows.find((row) => getWorkspaceSpaceWorktreeIdentity(row) === nextInspectedWorktreeId) ??
    rows.find((row) => row.status === 'ok') ??
    null
  const zoomedWorktree =
    sourceRows.find(
      (row) =>
        getWorkspaceSpaceWorktreeIdentity(row) === nextTreemapZoomWorktreeId && row.status === 'ok'
    ) ?? null
  const maxSize = getLargestWorkspaceSpaceRowSize(rows)
  const selectedDeletableRows = useMemo(
    () => getSelectedDeletableWorkspaceRows(rows, nextSelectedIds, isWorktreeUnavailableForDelete),
    [isWorktreeUnavailableForDelete, nextSelectedIds, rows]
  )
  const selectedDeletableIdentities = useMemo(
    () => selectedDeletableRows.map(getWorkspaceSpaceWorktreeIdentity),
    [selectedDeletableRows]
  )
  const selectedDeletableIdSet = useMemo(
    () => new Set(selectedDeletableIdentities),
    [selectedDeletableIdentities]
  )
  const visibleDeletableIdentities = useMemo(
    () => getVisibleDeletableWorkspaceIdentities(rows, isWorktreeUnavailableForDelete),
    [isWorktreeUnavailableForDelete, rows]
  )
  const allVisibleSelected =
    visibleDeletableIdentities.length > 0 &&
    visibleDeletableIdentities.every((id) => nextSelectedIds.has(id))
  const someVisibleSelected = visibleDeletableIdentities.some((id) => nextSelectedIds.has(id))
  const visibleSelectionState: boolean | 'mixed' = allVisibleSelected
    ? true
    : someVisibleSelected
      ? 'mixed'
      : false
  const isInitialScan = isScanning && !analysis
  const hasRows = sourceRows.length > 0
  const progressLabel = getWorkspaceSpaceProgressLabel(progress)
  const repoErrors = analysis?.repos.filter((repo) => repo.error !== null) ?? []
  const selectedReclaimableBytes = useMemo(
    () =>
      rows
        .filter((row) => selectedDeletableIdSet.has(getWorkspaceSpaceWorktreeIdentity(row)))
        .reduce((sum, row) => sum + row.reclaimableBytes, 0),
    [rows, selectedDeletableIdSet]
  )

  return {
    isWorktreeUnavailableForDelete,
    rows,
    nextInspectedWorktreeId,
    nextSelectedIds,
    nextTreemapZoomWorktreeId,
    inspectedWorktree,
    zoomedWorktree,
    maxSize,
    selectedDeletableRows,
    selectedDeletableIdentities,
    visibleDeletableIdentities,
    // Compatibility aliases retained for existing consumers; both are identities now.
    selectedDeletableIds: selectedDeletableIdentities,
    visibleDeletableIds: visibleDeletableIdentities,
    allVisibleSelected,
    visibleSelectionState,
    isInitialScan,
    hasRows,
    progressLabel,
    repoErrors,
    selectedReclaimableBytes
  }
}
