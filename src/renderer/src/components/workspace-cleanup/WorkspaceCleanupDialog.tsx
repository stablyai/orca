import React, { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { useTranslate } from '@/i18n/use-translate'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup/workspace-cleanup'
import {
  getWorkspaceCleanupCandidateIdentity,
  resolveWorkspaceCleanupRemovalHostId
} from '../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { WorkspaceCleanupBrowseToolbar } from './browse/workspace-cleanup-browse-toolbar'
import { WorkspaceCleanupConfirmStep } from './removal/workspace-cleanup-confirm-step'
import { WorkspaceCleanupRunStep } from './removal/run/workspace-cleanup-run-step'
import { useWorkspaceCleanupRunStore } from './removal/run/workspace-cleanup-run-store'
import {
  WorkspaceCleanupGroupCards,
  WORKSPACE_CLEANUP_GROUP_PANEL_ID,
  getWorkspaceCleanupGroupTabId
} from './dialog/workspace-cleanup-group-cards'
import { WorkspaceCleanupSelectAllBar } from './dialog/workspace-cleanup-select-all-bar'
import { WorkspaceCleanupPickFooter } from './dialog/workspace-cleanup-pick-footer'
import { useWorkspaceCleanupGroupedRows } from './dialog/use-workspace-cleanup-grouped-rows'
import { listActiveWorkspaceCleanupFacetGroups } from './browse/workspace-cleanup-active-facets'
import type { WorkspaceCleanupGroup } from '../../../../shared/workspace-cleanup/workspace-cleanup-groups'
import { WorkspaceCleanupConfirmStopAgents } from './removal/agent-consent/workspace-cleanup-confirm-stop-agents'
import { WorkspaceCleanupDialogHeader } from './dialog/workspace-cleanup-dialog-header'
import {
  getWorkspaceCleanupDeletionPhaseByIdentity,
  selectWorkspaceCleanupDeletionPhases
} from './removal/workspace-cleanup-deletion-phases'
import {
  WorkspaceCleanupInitialScanBanner,
  WorkspaceCleanupNotice,
  WorkspaceCleanupSkeletonRows
} from './dialog/workspace-cleanup-dialog-notices'
import { WorkspaceCleanupRowList } from './candidate-list/workspace-cleanup-row-list'
import { formatWorkspaceCleanupScanNotice } from './scanning/workspace-cleanup-scan-notice'
import { applyWorkspaceCleanupGitEvidence } from './candidate-evidence/workspace-cleanup-git-evidence'
import { useWorkspaceCleanupBrowseState } from './browse/use-workspace-cleanup-browse-state'
import {
  useWorkspaceCleanupDialogLifecycle,
  type WorkspaceCleanupDialogLifecycle
} from './dialog/use-workspace-cleanup-dialog-lifecycle'
import { useWorkspaceCleanupFacetRows } from './browse/use-workspace-cleanup-facet-rows'
import { useWorkspaceCleanupGitEvidence } from './candidate-evidence/use-workspace-cleanup-git-evidence'
import { useWorkspaceCleanupBulkSelection } from './browse/use-workspace-cleanup-bulk-selection'
import { useWorkspaceCleanupSpaceScan } from './browse/use-workspace-cleanup-space-scan'
import { useWorkspaceCleanupIgnore } from './browse/use-workspace-cleanup-ignore'
import { useWorkspaceCleanupHeldRows } from './candidate-list/use-workspace-cleanup-row-order'
import { openWorkspaceCleanupForgetLocally } from './removal/workspace-cleanup-forget-locally-button'
import {
  formatWithheldSelectionNotice,
  getSelectedDeletableCandidates,
  toggleSetMember
} from './browse/workspace-cleanup-selection-model'

export default function WorkspaceCleanupDialog(): React.JSX.Element | null {
  const lifecycle = useWorkspaceCleanupDialogLifecycle()
  if (!lifecycle.mountedContent) {
    return null
  }
  return <WorkspaceCleanupDialogContent {...lifecycle} />
}

function WorkspaceCleanupDialogContent({
  open,
  loading,
  closeModal,
  selectedIds,
  setSelectedIds,
  removal,
  startWorkspaceCleanupScan
}: WorkspaceCleanupDialogLifecycle): React.JSX.Element {
  const t = useTranslate()
  const scan = useAppStore((s) => s.workspaceCleanupScan)
  const scanProgress = useAppStore((s) => s.workspaceCleanupProgress)
  const error = useAppStore((s) => s.workspaceCleanupError)
  const repos = useAppStore((s) => s.repos)
  const markCandidateViewed = useAppStore((s) => s.markWorkspaceCleanupCandidateViewed)
  const spaceScan = useWorkspaceCleanupSpaceScan()
  const genericDeletionPhaseByWorktreeId = useAppStore(
    useShallow(selectWorkspaceCleanupDeletionPhases)
  )
  const browse = useWorkspaceCleanupBrowseState()
  const [facetPanelOpen, setFacetPanelOpen] = useState(false)
  const [activeGroup, setActiveGroup] = useState<WorkspaceCleanupGroup>('nothing-local')
  const run = useWorkspaceCleanupRunStore((s) => s.run)
  const dismissRun = useWorkspaceCleanupRunStore.getState().dismissRun
  const [expandedRowIds, setExpandedRowIds] = useState<Set<string>>(() => new Set())
  const [rowsScrollElement, setRowsScrollElement] = useState<HTMLDivElement | null>(null)
  const wasOpenRef = useRef(open)

  // Keep facet time stable but no older than dialog open; stale hydration must not misclassify idle/agent freshness.
  const [openedAt, setOpenedAt] = useState(() => Date.now())

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setOpenedAt(Date.now())
      listInteractedRef.current = false
    }
    wasOpenRef.current = open
  }, [open])

  const { removalInFlightRef } = removal
  const deletionPhaseByIdentity = useMemo(
    () =>
      getWorkspaceCleanupDeletionPhaseByIdentity(
        scan?.candidates ?? [],
        removal.deletionPhaseByIdentity,
        genericDeletionPhaseByWorktreeId
      ),
    [genericDeletionPhaseByWorktreeId, removal.deletionPhaseByIdentity, scan?.candidates]
  )
  const deletingIdentities = useMemo(
    () => new Set(Object.keys(deletionPhaseByIdentity)),
    [deletionPhaseByIdentity]
  )

  const candidates = useMemo(() => scan?.candidates ?? [], [scan?.candidates])
  // Fill deferred broad-scan Git reads while open so every browse row gets evidence.
  const gitEvidenceNeeded = open
  const gitEvidence = useWorkspaceCleanupGitEvidence({
    enabled: gitEvidenceNeeded,
    candidates,
    scannedAt: scan?.scannedAt ?? null
  })
  const evidencedCandidates = useMemo(
    () => applyWorkspaceCleanupGitEvidence(candidates, gitEvidence.evidenceByIdentity),
    [candidates, gitEvidence.evidenceByIdentity]
  )
  // Use the newer of scan/open time: stable across renders without aging a fresh scan back to stale hydration.
  const facetNow = Math.max(scan?.scannedAt ?? 0, openedAt)
  const facetRows = useWorkspaceCleanupFacetRows({
    candidates: evidencedCandidates,
    filters: browse.filters,
    sort: browse.sort,
    now: facetNow,
    facetPanelOpen
  })
  const selectedIdsRef = useRef(selectedIds)
  useEffect(() => {
    selectedIdsRef.current = selectedIds
  }, [selectedIds])
  // Held order must never wait on the user's first touch, so interaction is tracked in a ref.
  const listInteractedRef = useRef(false)
  const markListInteracted = useCallback(() => {
    listInteractedRef.current = true
  }, [])
  useEffect(() => {
    // Only the user's own input counts: wheel, touch, scrollbar drag, keys, focus, pointerdown.
    // Programmatic scrolls (virtualizer restore, scrollIntoView) must not suppress the settle sort.
    const target = rowsScrollElement?.parentElement ?? rowsScrollElement
    if (!target) {
      return
    }
    const events = ['wheel', 'touchmove', 'pointerdown', 'keydown', 'focusin'] as const
    for (const name of events) {
      target.addEventListener(name, markListInteracted, { passive: true, capture: true })
    }
    return () => {
      for (const name of events) {
        target.removeEventListener(name, markListInteracted, { capture: true })
      }
    }
  }, [markListInteracted, rowsScrollElement])
  const liveRowByIdentity = useMemo(
    () => new Map(facetRows.allRows.map((row) => [row.identity, row])),
    [facetRows.allRows]
  )
  const orderResetKey = `${browse.sort.field}:${browse.sort.direction}:${JSON.stringify(browse.filters)}`
  const { rows, releaseRows } = useWorkspaceCleanupHeldRows({
    liveRows: facetRows.rows,
    liveRowByIdentity,
    resetKey: orderResetKey,
    open,
    loading,
    gitChecking: gitEvidence.pendingWorktreeIds.size > 0,
    // Re-sorting at settle is safe only while the user has not started working in the list.
    shouldResortAtSettle: () => selectedIdsRef.current.size === 0 && !listInteractedRef.current
  })
  // Host-qualify selection: identical workspace IDs on different hosts must never confirm one row and delete another (STA-4343).
  const candidateIdentities = useMemo(
    () => new Set(candidates.map((candidate) => getWorkspaceCleanupCandidateIdentity(candidate))),
    [candidates]
  )

  const scanNoticeMessage = useMemo(
    () =>
      formatWorkspaceCleanupScanNotice(
        scan?.errors ?? [],
        new Map(repos.map((repo) => [repo.id, repo.displayName || repo.path]))
      ),
    [repos, scan?.errors]
  )
  const initialLoading = loading && candidates.length === 0

  const pruneSelectionToVisibleRows = useEffectEvent(() => {
    if (!open || removal.confirming) {
      return
    }
    const next = new Set(
      [...selectedIds].filter(
        (identity) =>
          facetRows.facetMatchedIdentities.has(identity) && !deletingIdentities.has(identity)
      )
    )
    if (next.size === selectedIds.size) {
      return
    }
    setSelectedIds(next)
    toast.info(formatWithheldSelectionNotice(selectedIds.size - next.size))
  })

  useEffect(() => {
    // Prune destructive selections only when user filters change. Streaming reclassification and
    // returning from confirmation must not silently deselect rows the list still displays.
    pruneSelectionToVisibleRows()
  }, [browse.filters, open])

  const { ignoreCandidate: recordIgnore, restoreCandidate: recordRestore } =
    useWorkspaceCleanupIgnore(setSelectedIds)
  // Ignore/Restore touches only that row: once the change is committed it leaves or re-enters
  // the list (at the end), and nothing else moves.
  const ignoreCandidate = useCallback(
    (candidate: WorkspaceCleanupCandidate) => {
      void recordIgnore(candidate).then((done) => {
        if (done) {
          releaseRows([getWorkspaceCleanupCandidateIdentity(candidate)])
        }
      })
    },
    [recordIgnore, releaseRows]
  )
  const restoreCandidate = useCallback(
    (candidate: WorkspaceCleanupCandidate) => {
      void recordRestore(candidate).then((done) => {
        if (done) {
          releaseRows([getWorkspaceCleanupCandidateIdentity(candidate)])
        }
      })
    },
    [recordRestore, releaseRows]
  )

  const toggleExpandedRow = useCallback(
    (identity: string) => setExpandedRowIds((current) => toggleSetMember(current, identity)),
    []
  )

  const toggleSelectedRow = useCallback(
    (identity: string) => setSelectedIds((current) => toggleSetMember(current, identity)),
    [setSelectedIds]
  )

  const {
    rowsByGroup,
    groupSummaries,
    getRowGroup,
    resetGroups,
    uncheckedCount,
    updatesAvailable,
    visibleIdentities
  } = useWorkspaceCleanupGroupedRows({
    rows,
    candidates: evidencedCandidates,
    open,
    scanning: loading,
    gitEvidence,
    selectedIds,
    deletingIdentities
  })
  const selectedCandidates = useMemo(
    () =>
      getSelectedDeletableCandidates(
        rows.filter((row) => visibleIdentities.has(row.identity)),
        selectedIds,
        deletingIdentities
      ),
    [deletingIdentities, rows, selectedIds, visibleIdentities]
  )
  const selectedCount = selectedCandidates.length
  const hasActiveFilters = useMemo(
    () =>
      browse.filters.query.trim().length > 0 ||
      listActiveWorkspaceCleanupFacetGroups(browse.filters).length > 0,
    [browse.filters]
  )

  const bulk = useWorkspaceCleanupBulkSelection({
    rows: rowsByGroup[activeGroup],
    selectedIds,
    setSelectedIds,
    deletingIdentities,
    removalInFlight: removal.removalInFlight,
    evidencedCandidates,
    candidateIdentities,
    loading
  })

  const openConfirmRemove = removal.openConfirmRemove
  const handleRemoveRow = useCallback(
    (candidate: WorkspaceCleanupCandidate) => {
      if (removalInFlightRef.current) {
        return
      }
      setSelectedIds(new Set([getWorkspaceCleanupCandidateIdentity(candidate)]))
      openConfirmRemove([candidate])
    },
    [openConfirmRemove, removalInFlightRef, setSelectedIds]
  )
  const handleViewCandidate = useCallback(
    (candidate: WorkspaceCleanupCandidate) => {
      markCandidateViewed(candidate)
      closeModal()
      const executionHostId = resolveWorkspaceCleanupRemovalHostId(candidate)
      activateAndRevealWorktree(candidate.worktreeId, {
        executionHostId: executionHostId ?? undefined
      })
    },
    [closeModal, markCandidateViewed]
  )

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && closeModal()}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(820px,90vh)] w-[calc(100vw-3rem)] max-w-[calc(100vw-3rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-3rem)] xl:w-[980px] xl:max-w-[980px]"
      >
        {removal.agentStopRequest ? (
          <WorkspaceCleanupConfirmStopAgents
            candidates={removal.agentStopRequest.candidates}
            onBack={removal.cancelStopAgents}
            onConfirm={removal.confirmStopAgents}
          />
        ) : run ? (
          <WorkspaceCleanupRunStep
            run={run}
            now={facetNow}
            onDeleteAnyway={removal.confirmUnverifiedRemoval}
            onClose={closeModal}
            onDone={() => dismissRun(run.id)}
          />
        ) : removal.confirming ? (
          <WorkspaceCleanupConfirmStep
            candidates={removal.confirmCandidates}
            now={facetNow}
            onBack={removal.backToList}
            onClose={closeModal}
            onConfirm={removal.confirmRemove}
          />
        ) : (
          <>
            <WorkspaceCleanupDialogHeader
              title={t('components.workspace.cleanup.review.title', 'Review workspaces')}
              loading={loading}
              checking={gitEvidence.pendingWorktreeIds.size > 0}
              updatesAvailable={updatesAvailable}
              onRefresh={() => {
                resetGroups()
                startWorkspaceCleanupScan({ notifyWhenReady: true })
              }}
              onClose={closeModal}
            />

            {initialLoading ? <WorkspaceCleanupInitialScanBanner progress={scanProgress} /> : null}
            {error ? <WorkspaceCleanupNotice tone="destructive" message={error} /> : null}
            {!error && spaceScan.error ? (
              <WorkspaceCleanupNotice tone="destructive" message={spaceScan.error} />
            ) : null}
            {!error && scanNoticeMessage ? (
              <WorkspaceCleanupNotice message={scanNoticeMessage} />
            ) : null}

            <WorkspaceCleanupBrowseToolbar
              browse={browse}
              facetRows={facetRows}
              facetPanelOpen={facetPanelOpen}
              onFacetPanelOpenChange={setFacetPanelOpen}
              spaceScanning={spaceScan.scanning}
              spaceProgress={spaceScan.progress}
              gitPendingCount={gitEvidence.pendingWorktreeIds.size}
              gitCheckedTotal={gitEvidence.totalCount}
              onRunSpaceScan={spaceScan.runSpaceScan}
            />

            <WorkspaceCleanupGroupCards
              active={activeGroup}
              summaries={groupSummaries}
              onChange={setActiveGroup}
            />
            {activeGroup !== 'cannot-delete' ? (
              <WorkspaceCleanupSelectAllBar
                selectableCount={bulk.bulkSelectableCount}
                selectedBulkCount={bulk.selectedBulkCount}
                selectedDisplayedCount={bulk.selectedDisplayedCount}
                onToggle={bulk.toggleSelectAll}
              />
            ) : null}

            <ScrollArea className="min-h-0 flex-1" viewportRef={setRowsScrollElement}>
              <div
                role="tabpanel"
                id={WORKSPACE_CLEANUP_GROUP_PANEL_ID}
                aria-labelledby={getWorkspaceCleanupGroupTabId(activeGroup)}
              >
                {initialLoading || (uncheckedCount > 0 && rowsByGroup[activeGroup].length === 0) ? (
                  <WorkspaceCleanupSkeletonRows />
                ) : null}
                <WorkspaceCleanupRowList
                  rows={rowsByGroup[activeGroup]}
                  now={facetNow}
                  scannedCandidates={candidates}
                  hasActiveFilters={hasActiveFilters}
                  getRowGroup={getRowGroup}
                  hasScanned={scan != null}
                  loading={loading || uncheckedCount > 0}
                  deletionPhaseByIdentity={deletionPhaseByIdentity}
                  deletingIdentities={deletingIdentities}
                  expandedRowIds={expandedRowIds}
                  selectedIds={selectedIds}
                  rowFailures={removal.rowFailures}
                  scrollElement={rowsScrollElement}
                  onClearFilters={browse.clearFilters}
                  onToggleExpanded={toggleExpandedRow}
                  onToggleSelected={toggleSelectedRow}
                  onView={handleViewCandidate}
                  onIgnore={ignoreCandidate}
                  onRestore={restoreCandidate}
                  onRemove={handleRemoveRow}
                  onForgetLocally={openWorkspaceCleanupForgetLocally}
                  onDeleteAnyway={removal.confirmUnverifiedRemoval}
                />
              </div>
            </ScrollArea>

            <WorkspaceCleanupPickFooter
              selectedCount={selectedCount}
              deleteBlocked={removal.removalInFlight}
              onDelete={() => openConfirmRemove(selectedCandidates)}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
