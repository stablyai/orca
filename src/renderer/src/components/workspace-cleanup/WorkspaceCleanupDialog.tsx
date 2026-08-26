import React, { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { translate } from '@/i18n/i18n'
import {
  canQueueWorkspaceCleanupCandidate,
  type WorkspaceCleanupCandidate
} from '../../../../shared/workspace-cleanup'
import {
  getWorkspaceCleanupCandidateIdentity,
  resolveWorkspaceCleanupRemovalHostId
} from '../../../../shared/workspace-cleanup-host-identity'
import { WorkspaceCleanupBrowseToolbar } from './workspace-cleanup-browse-toolbar'
import { WorkspaceCleanupConfirmRemove } from './workspace-cleanup-confirm-remove'
import { WorkspaceCleanupDialogHeader } from './workspace-cleanup-dialog-header'
import {
  getWorkspaceCleanupDeletionPhaseByIdentity,
  selectWorkspaceCleanupDeletionPhases
} from './workspace-cleanup-deletion-phases'
import {
  WorkspaceCleanupInitialScanBanner,
  WorkspaceCleanupNotice,
  WorkspaceCleanupSkeletonRows
} from './workspace-cleanup-dialog-notices'
import { WorkspaceCleanupRowList } from './workspace-cleanup-row-list'
import { formatWorkspaceCleanupScanNotice } from './workspace-cleanup-scan-notice'
import {
  applyWorkspaceCleanupGitEvidence,
  needsWorkspaceCleanupGitEvidence
} from './workspace-cleanup-git-evidence'
import { useWorkspaceCleanupBrowseState } from './use-workspace-cleanup-browse-state'
import {
  useWorkspaceCleanupDialogLifecycle,
  type WorkspaceCleanupDialogLifecycle
} from './use-workspace-cleanup-dialog-lifecycle'
import { useWorkspaceCleanupFacetRows } from './use-workspace-cleanup-facet-rows'
import { useWorkspaceCleanupGitEvidence } from './use-workspace-cleanup-git-evidence'
import { useWorkspaceCleanupRowOrder } from './use-workspace-cleanup-row-order'
import { openWorkspaceCleanupForgetLocally } from './workspace-cleanup-forget-locally-button'
import {
  formatVanishedSelectionNotice,
  formatWithheldSelectionNotice,
  toggleSetMember
} from './workspace-cleanup-selection-model'

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
  const scan = useAppStore((s) => s.workspaceCleanupScan)
  const scanProgress = useAppStore((s) => s.workspaceCleanupProgress)
  const error = useAppStore((s) => s.workspaceCleanupError)
  const spaceError = useAppStore((s) => s.workspaceSpaceScanError)
  const repos = useAppStore((s) => s.repos)
  const markCandidateViewed = useAppStore((s) => s.markWorkspaceCleanupCandidateViewed)
  const dismissCandidates = useAppStore((s) => s.dismissWorkspaceCleanupCandidates)
  const refreshWorkspaceSpace = useAppStore((s) => s.refreshWorkspaceSpace)
  const workspaceSpaceScanning = useAppStore((s) => s.workspaceSpaceScanning)
  const workspaceSpaceProgress = useAppStore((s) => s.workspaceSpaceScanProgress)
  const genericDeletionPhaseByWorktreeId = useAppStore(
    useShallow(selectWorkspaceCleanupDeletionPhases)
  )
  const browse = useWorkspaceCleanupBrowseState()
  const [facetPanelOpen, setFacetPanelOpen] = useState(false)
  const [expandedRowIds, setExpandedRowIds] = useState<Set<string>>(() => new Set())
  const [rowsScrollElement, setRowsScrollElement] = useState<HTMLDivElement | null>(null)
  const wasOpenRef = useRef(open)
  const mountedRef = useMountedRef()

  // Why: the facet clock must be stable across renders but never older than
  // this open — a hydrated snapshot's scannedAt can be days stale, which would
  // misbucket idle thresholds and keep dead agent statuses "fresh".
  const [openedAt, setOpenedAt] = useState(() => Date.now())

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setOpenedAt(Date.now())
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
  const gitEvidenceNeeded = open && needsWorkspaceCleanupGitEvidence(browse.filters, browse.sort)
  const gitEvidence = useWorkspaceCleanupGitEvidence({
    enabled: gitEvidenceNeeded,
    candidates,
    scannedAt: scan?.scannedAt ?? null
  })
  const evidencedCandidates = useMemo(
    () => applyWorkspaceCleanupGitEvidence(candidates, gitEvidence.evidenceByIdentity),
    [candidates, gitEvidence.evidenceByIdentity]
  )
  // Why: a live clock would re-run every facet on each render; the newer of
  // scan time and open time is the honest stable "as of" moment — a fresh scan
  // keeps its timestamp, a stale hydrated snapshot is judged from this open.
  const facetNow = Math.max(scan?.scannedAt ?? 0, openedAt)
  const facetRows = useWorkspaceCleanupFacetRows({
    candidates: evidencedCandidates,
    filters: browse.filters,
    sort: browse.sort,
    now: facetNow,
    facetPanelOpen
  })
  const rows = useWorkspaceCleanupRowOrder({
    rows: facetRows.rows,
    streaming: loading,
    sort: browse.sort
  })
  // Why (STA-4343): rows are keyed by host-qualified identity, not by
  // `worktreeId` — two hosts can list the same `repoId::path` workspace, and an
  // id-keyed selection would confirm one host's row and delete the other's.
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
  const runSpaceScan = useCallback(() => {
    void refreshWorkspaceSpace().catch((scanError: unknown) => {
      if (!mountedRef.current) {
        return
      }
      toast.error(
        translate(
          'components.workspace.cleanup.browse.measureSizesFailed',
          'Could not scan workspace sizes'
        ),
        {
          description: scanError instanceof Error ? scanError.message : String(scanError)
        }
      )
    })
  }, [mountedRef, refreshWorkspaceSpace])

  const selectedCandidates = useMemo(() => {
    const byIdentity = new Map(rows.map((row) => [row.identity, row.candidate]))
    return [...selectedIds]
      .map((identity) => byIdentity.get(identity))
      .filter(
        (candidate): candidate is WorkspaceCleanupCandidate =>
          candidate != null &&
          canQueueWorkspaceCleanupCandidate(candidate) &&
          !deletingIdentities.has(getWorkspaceCleanupCandidateIdentity(candidate))
      )
  }, [deletingIdentities, rows, selectedIds])
  const selectedCount = selectedCandidates.length

  // A destructive dialog leaves selection to the user.

  const pruneSelectionToVisibleRows = useEffectEvent(() => {
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
    if (!open || removal.confirming) {
      return
    }
    // Why: destructive selection must stay scoped to the rows the user can
    // currently review after a filter change — and only then; keying on the
    // user's filter state (not the matched set, whose identity changes every
    // streaming tick) keeps a re-classified row from being silently deselected.
    pruneSelectionToVisibleRows()
  }, [browse.filters, open, removal.confirming])

  const pruneVanishedSelections = useEffectEvent(() => {
    const isDeleting = (identity: string): boolean => deletingIdentities.has(identity)
    const kept = [...selectedIds].filter(
      (identity) => candidateIdentities.has(identity) && !isDeleting(identity)
    )
    if (kept.length === selectedIds.size) {
      return
    }
    const vanishedCount = [...selectedIds].filter(
      (identity) => !candidateIdentities.has(identity) && !isDeleting(identity)
    ).length
    setSelectedIds(new Set(kept))
    if (vanishedCount > 0) {
      toast.info(formatVanishedSelectionNotice(vanishedCount))
    }
  })

  useEffect(() => {
    if (loading) {
      return
    }
    pruneVanishedSelections()
  }, [candidateIdentities, deletingIdentities, loading])

  const ignoreCandidate = useCallback(
    (candidate: WorkspaceCleanupCandidate) => {
      void dismissCandidates([candidate])
        .then(() => {
          if (mountedRef.current) {
            setSelectedIds((current) => {
              const next = new Set(current)
              next.delete(getWorkspaceCleanupCandidateIdentity(candidate))
              return next
            })
          }
        })
        .catch((err: unknown) => {
          if (mountedRef.current) {
            toast.error(
              translate(
                'auto.components.workspace.cleanup.WorkspaceCleanupDialog.7f451a3e2c',
                'Could not ignore cleanup suggestion'
              ),
              { description: err instanceof Error ? err.message : String(err) }
            )
          }
        })
    },
    [dismissCandidates, mountedRef, setSelectedIds]
  )

  const toggleExpandedRow = useCallback((identity: string) => {
    setExpandedRowIds((current) => toggleSetMember(current, identity))
  }, [])

  const toggleSelectedRow = useCallback(
    (identity: string) => {
      setSelectedIds((current) => toggleSetMember(current, identity))
    },
    [setSelectedIds]
  )

  const selectableIdentities = useMemo(
    () =>
      removal.removalInFlight
        ? []
        : facetRows.selectableIdentities.filter((identity) => !deletingIdentities.has(identity)),
    [deletingIdentities, facetRows.selectableIdentities, removal.removalInFlight]
  )
  // Header state is scoped to the same rows the header action controls.
  const selectedSelectableCount = useMemo(() => {
    let count = 0
    for (const identity of selectableIdentities) {
      if (selectedIds.has(identity)) {
        count += 1
      }
    }
    return count
  }, [selectableIdentities, selectedIds])

  const toggleSelectAll = useCallback(
    (selectAll: boolean) => {
      setSelectedIds((current) => {
        const next = new Set(current)
        for (const identity of selectableIdentities) {
          if (selectAll) {
            next.add(identity)
          } else {
            next.delete(identity)
          }
        }
        return next
      })
    },
    [selectableIdentities, setSelectedIds]
  )

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

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        closeModal()
      }
    },
    [closeModal]
  )

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(820px,90vh)] w-[calc(100vw-3rem)] max-w-[calc(100vw-3rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-3rem)] xl:w-[980px] xl:max-w-[980px]"
      >
        {!removal.confirming ? (
          <>
            <WorkspaceCleanupDialogHeader
              selectedCount={selectedCount}
              loading={loading}
              scannedAt={scan?.scannedAt ?? null}
              scanProgress={scanProgress}
              deleteDisabled={
                selectedCount === 0 || removal.removalProgress !== null || removal.removalInFlight
              }
              onDeleteSelected={() => openConfirmRemove(selectedCandidates)}
              onRefresh={() => startWorkspaceCleanupScan({ notifyWhenReady: true })}
              onClose={closeModal}
            />

            {initialLoading ? <WorkspaceCleanupInitialScanBanner progress={scanProgress} /> : null}
            {error ? <WorkspaceCleanupNotice tone="destructive" message={error} /> : null}
            {!error && spaceError ? (
              <WorkspaceCleanupNotice tone="destructive" message={spaceError} />
            ) : null}
            {!error && scanNoticeMessage ? (
              <WorkspaceCleanupNotice message={scanNoticeMessage} />
            ) : null}

            <WorkspaceCleanupBrowseToolbar
              browse={browse}
              facetRows={facetRows}
              facetPanelOpen={facetPanelOpen}
              onFacetPanelOpenChange={setFacetPanelOpen}
              selectableCount={selectableIdentities.length}
              selectedCount={selectedSelectableCount}
              spaceScanning={workspaceSpaceScanning}
              spaceProgress={workspaceSpaceProgress}
              gitPendingCount={gitEvidence.pendingWorktreeIds.size}
              gitCheckedTotal={gitEvidence.totalCount}
              onRunSpaceScan={runSpaceScan}
              onToggleSelectAll={toggleSelectAll}
            />

            <ScrollArea className="min-h-0 flex-1" viewportRef={setRowsScrollElement}>
              <div>
                {initialLoading ? <WorkspaceCleanupSkeletonRows /> : null}
                <WorkspaceCleanupRowList
                  rows={rows}
                  now={facetNow}
                  scannedCount={candidates.length}
                  hasScanned={scan != null}
                  loading={loading}
                  deletionPhaseByIdentity={deletionPhaseByIdentity}
                  deletingIdentities={deletingIdentities}
                  expandedRowIds={expandedRowIds}
                  selectedIds={selectedIds}
                  gitPendingWorktreeIds={gitEvidence.pendingWorktreeIds}
                  rowFailures={removal.rowFailures}
                  scrollElement={rowsScrollElement}
                  onClearFilters={browse.clearFilters}
                  onToggleExpanded={toggleExpandedRow}
                  onToggleSelected={toggleSelectedRow}
                  onView={handleViewCandidate}
                  onIgnore={ignoreCandidate}
                  onRemove={handleRemoveRow}
                  onForgetLocally={openWorkspaceCleanupForgetLocally}
                  onDeleteAnyway={removal.confirmUnverifiedRemoval}
                />
              </div>
            </ScrollArea>
          </>
        ) : (
          <WorkspaceCleanupConfirmRemove
            candidates={removal.confirmCandidates}
            now={facetNow}
            reviewInfoByWorktreeId={facetRows.reviewInfoByWorktreeId}
            progress={removal.removalProgress}
            onBack={removal.backToList}
            onCancel={removal.cancelConfirmRemove}
            onConfirm={removal.confirmRemove}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
