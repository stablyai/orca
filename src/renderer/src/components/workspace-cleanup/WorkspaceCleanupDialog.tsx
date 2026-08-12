/* eslint-disable max-lines -- Why: the cleanup dialog keeps scan status,
   filters, row actions, localized review copy, and force-aware confirmation
   in one modal flow. */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Info,
  Loader2,
  RefreshCcw,
  Search,
  SlidersHorizontal,
  Trash2,
  X
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import RepoMultiCombobox from '@/components/ui/repo-multi-combobox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import {
  canQueueWorkspaceCleanupCandidate,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupScanError,
  type WorkspaceCleanupScanProgress
} from '../../../../shared/workspace-cleanup'
import {
  filterWorkspaceCleanupCandidates,
  getWorkspaceCleanupReviewInfo,
  sortWorkspaceCleanupCandidates,
  type WorkspaceCleanupContextFilter,
  type WorkspaceCleanupFilters,
  type WorkspaceCleanupGitFilter,
  type WorkspaceCleanupReviewFilter,
  type WorkspaceCleanupReviewInfo,
  type WorkspaceCleanupSortDirection,
  type WorkspaceCleanupSortKey,
  type WorkspaceCleanupTimeFilter
} from './workspace-cleanup-presentation'
import type { WorkspaceCleanupRemovalProgress } from './workspace-cleanup-background-removal'
import { countEstimatedInactiveWorkspaces } from './inactive-workspace-estimate'
import { CandidateRow, type WorkspaceCleanupDeletionPhase } from './workspace-cleanup-candidate-row'
import { WorkspaceCleanupCandidateList } from './workspace-cleanup-candidate-list'
import {
  getCandidateStatus,
  getContextPillLabel,
  getDirtyGitLabel,
  getReviewPillTone,
  shouldShowGitMetadataChip
} from './workspace-cleanup-candidate-row-data'
import { StatusPill } from './workspace-cleanup-status-pill'
import {
  resolveWorkspaceCleanupActiveView,
  type WorkspaceCleanupView,
  type WorkspaceCleanupViewCounts
} from './workspace-cleanup-view-selection'
import {
  DEFAULT_WORKSPACE_CLEANUP_FILTERS,
  useWorkspaceCleanupDialogSession,
  type WorkspaceCleanupDialogSession
} from './workspace-cleanup-dialog-session'
import { translate } from '@/i18n/i18n'

const WORKSPACE_CLEANUP_CLOSE_LINGER_MS = 300

const EMPTY_REVIEW_INFO: WorkspaceCleanupReviewInfo = {
  hasReview: false,
  label: null,
  state: null,
  provider: null,
  title: null
}

function formatRelativeTime(timestamp: number): string {
  if (!timestamp) {
    return 'Never'
  }
  const deltaMs = Date.now() - timestamp
  if (deltaMs < 60_000) {
    return 'Just now'
  }
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 60) {
    return `${minutes}m ago`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 48) {
    return `${hours}h ago`
  }
  return `${Math.floor(hours / 24)}d ago`
}

function isDisconnectedRemoteScanError(message: string): boolean {
  return (
    message === 'SSH provider is unavailable.' ||
    message === 'Remote workspaces are not connected. Reconnect and refresh to check them.'
  )
}

function formatScanNoticeMessage(
  errors: WorkspaceCleanupScanError[],
  repoNameById: Map<string, string>
): string | null {
  const visibleErrors = errors.filter(
    (error) => !isDisconnectedRemoteScanError(error.message ?? '')
  )
  if (visibleErrors.length === 0) {
    return null
  }
  if (visibleErrors.length === 1) {
    const error = visibleErrors[0]
    const repoName = formatScanErrorRepoName(error, repoNameById)
    return `Could not check ${repoName}: ${formatScanErrorReason(error.message)}. Some inactive workspaces may be missing. Refresh to try again.`
  }
  const repoNames = visibleErrors
    .slice(0, 3)
    .map((error) => formatScanErrorRepoName(error, repoNameById))
    .join(', ')
  const moreCount = visibleErrors.length - 3
  const suffix = moreCount > 0 ? `, +${moreCount} more` : ''
  return `Could not check ${visibleErrors.length} repositories (${repoNames}${suffix}). Some inactive workspaces may be missing. Refresh to try again.`
}

function formatScanErrorRepoName(
  error: Partial<WorkspaceCleanupScanError>,
  repoNameById: Map<string, string>
): string {
  const repoName = error.repoName?.trim()
  if (repoName) {
    return repoName
  }
  const fallback = error.repoId ? repoNameById.get(error.repoId)?.trim() : ''
  return fallback || 'a repository'
}

function formatScanErrorReason(message: string | undefined): string {
  if (!message) {
    return 'Git could not list worktrees'
  }
  if (message === 'Could not scan workspace cleanup for this repository.') {
    return 'Git could not list worktrees'
  }
  return message.replace(/\.$/, '')
}

export default function WorkspaceCleanupDialog(): React.JSX.Element | null {
  // Why: scans and removals outlive the modal; only the subscribed projection tree may unmount.
  const session = useWorkspaceCleanupDialogSession()
  const [lingering, setLingering] = useState(session.open)
  useEffect(() => {
    if (session.open) {
      setLingering(true)
      return
    }
    const timer = window.setTimeout(() => setLingering(false), WORKSPACE_CLEANUP_CLOSE_LINGER_MS)
    return () => window.clearTimeout(timer)
  }, [session.open])

  if (!session.open && !lingering) {
    return null
  }
  return <WorkspaceCleanupDialogContent session={session} />
}

function WorkspaceCleanupDialogContent({
  session
}: {
  session: WorkspaceCleanupDialogSession
}): React.JSX.Element {
  const {
    open,
    loading,
    selectedIds,
    setSelectedIds,
    expandedRowIds,
    setExpandedRowIds,
    activeView,
    setActiveView,
    confirming,
    confirmCandidates,
    removalProgress,
    removalInFlight,
    rowFailures,
    repoSelection,
    setRepoSelection,
    filters,
    setFilters,
    sortKey,
    setSortKey,
    sortDirection,
    setSortDirection,
    selectedDefaultsScanAtRef,
    removalInFlightRef,
    close: closeModal,
    markCandidateViewed,
    restoreDismissals: resetDismissals,
    startScan: startWorkspaceCleanupScan,
    ignoreCandidate,
    applyScanDefaults,
    openConfirmRemove,
    cancelConfirmRemove,
    backToWorkspaceCleanupList,
    confirmRemove
  } = session
  const scan = useAppStore((s) => s.workspaceCleanupScan)
  const scanProgress = useAppStore((s) => s.workspaceCleanupProgress)
  const error = useAppStore((s) => s.workspaceCleanupError)
  const repos = useAppStore((s) => s.repos)
  const reviewStateInputs = useAppStore(
    useShallow((s) => ({
      worktreesByRepo: s.worktreesByRepo,
      hostedReviewCache: s.hostedReviewCache,
      repos: s.repos,
      settings: s.settings
    }))
  )
  const deletionPhaseByWorktreeId = useAppStore(
    useShallow((s) => {
      const phases: Record<string, WorkspaceCleanupDeletionPhase> = {}
      for (const [worktreeId, state] of Object.entries(s.deleteStateByWorktreeId)) {
        if (state.isDeleting) {
          phases[worktreeId] = state.phase ?? 'deleting'
        }
      }
      return phases
    })
  )
  const deletingWorktreeIds = useMemo(
    () => new Set(Object.keys(deletionPhaseByWorktreeId)),
    [deletionPhaseByWorktreeId]
  )

  const [rowsScrollElement, setRowsScrollElement] = useState<HTMLDivElement | null>(null)
  const eligibleRepos = useMemo(() => repos.filter((repo) => isGitRepoKind(repo)), [repos])
  const eligibleRepoIds = useMemo(() => eligibleRepos.map((repo) => repo.id), [eligibleRepos])

  useEffect(() => {
    if (!open) {
      return
    }
    setRepoSelection(new Set(eligibleRepoIds))
  }, [eligibleRepoIds, open, setRepoSelection])

  const candidates = useMemo(() => scan?.candidates ?? [], [scan?.candidates])
  const reviewInfoByWorktreeId = useMemo(() => {
    const infos = new Map<string, WorkspaceCleanupReviewInfo>()
    for (const candidate of candidates) {
      infos.set(candidate.worktreeId, getWorkspaceCleanupReviewInfo(candidate, reviewStateInputs))
    }
    return infos
  }, [candidates, reviewStateInputs])
  const effectiveRepoSelection = useMemo<ReadonlySet<string>>(() => {
    if (repoSelection.size > 0 || eligibleRepoIds.length === 0) {
      return repoSelection
    }
    return new Set(eligibleRepoIds)
  }, [eligibleRepoIds, repoSelection])
  const selectedScanErrors = useMemo(
    () => (scan?.errors ?? []).filter((error) => effectiveRepoSelection.has(error.repoId)),
    [effectiveRepoSelection, scan?.errors]
  )
  const filteredCandidates = useMemo(() => {
    if (
      effectiveRepoSelection.size === 0 ||
      effectiveRepoSelection.size === eligibleRepoIds.length
    ) {
      return candidates
    }
    return candidates.filter((candidate) => effectiveRepoSelection.has(candidate.repoId))
  }, [candidates, effectiveRepoSelection, eligibleRepoIds.length])
  // Why: the Resource Manager button counts from the renderer's activity record only,
  // so it routinely disagrees with the scanned list. Reconcile it rather than leaving
  // the user to wonder which number is real.
  const estimatedInactiveCount = useMemo(() => {
    if (!open) {
      return null
    }
    return countEstimatedInactiveWorkspaces(
      Object.values(reviewStateInputs.worktreesByRepo).flat(),
      new Map(reviewStateInputs.repos.map((repo) => [repo.id, repo])),
      Date.now()
    )
  }, [open, reviewStateInputs])
  // Why: the reconciliation only holds for a complete scan; a failed or partial
  // one would blame the difference on git-history checks instead of the error.
  const estimateMismatchNotice =
    !loading &&
    !error &&
    selectedScanErrors.length === 0 &&
    scan &&
    estimatedInactiveCount !== null &&
    estimatedInactiveCount !== candidates.length &&
    filteredCandidates.length === candidates.length
      ? translate(
          'auto.components.workspace.cleanup.WorkspaceCleanupDialog.f637f63882',
          "Resource Manager counts {{value0}}; this list found {{value1}}. That counter reads Orca's activity record alone, while this scan also checks each workspace's git history and skips disconnected remotes.",
          { value0: estimatedInactiveCount, value1: candidates.length }
        )
      : null

  useEffect(() => {
    if (loading || !scan || selectedDefaultsScanAtRef.current === scan.scannedAt) {
      return
    }
    selectedDefaultsScanAtRef.current = scan.scannedAt
    applyScanDefaults(scan.candidates, deletingWorktreeIds)
  }, [applyScanDefaults, deletingWorktreeIds, loading, scan, selectedDefaultsScanAtRef])

  const visibleCandidates = useMemo(() => {
    const rows = filteredCandidates.filter((candidate) => !candidate.blockers.includes('dismissed'))
    return sortWorkspaceCleanupCandidates(rows, 'activity', 'asc', reviewInfoByWorktreeId)
  }, [filteredCandidates, reviewInfoByWorktreeId])
  const hiddenCandidates = useMemo(
    () =>
      sortWorkspaceCleanupCandidates(
        filteredCandidates.filter((candidate) => candidate.blockers.includes('dismissed')),
        'activity',
        'asc',
        reviewInfoByWorktreeId
      ),
    [filteredCandidates, reviewInfoByWorktreeId]
  )
  const groups = useMemo(
    () => ({
      ready: visibleCandidates.filter((candidate) => candidate.tier === 'ready'),
      review: visibleCandidates.filter((candidate) => candidate.tier === 'review'),
      protected: visibleCandidates.filter((candidate) => candidate.tier === 'protected')
    }),
    [visibleCandidates]
  )
  const cleanupViewCounts = useMemo<WorkspaceCleanupViewCounts>(
    () => ({
      ready: groups.ready.length,
      review: groups.review.length,
      protected: groups.protected.length,
      hidden: hiddenCandidates.length
    }),
    [groups.protected.length, groups.ready.length, groups.review.length, hiddenCandidates.length]
  )
  const resolvedActiveView = resolveWorkspaceCleanupActiveView({
    requestedView: activeView,
    counts: cleanupViewCounts,
    open,
    loading,
    hasScan: scan != null
  })
  const repoNameById = useMemo(
    () => new Map(repos.map((repo) => [repo.id, repo.displayName || repo.path])),
    [repos]
  )
  const scanNoticeMessage = useMemo(
    () => formatScanNoticeMessage(selectedScanErrors, repoNameById),
    [repoNameById, selectedScanErrors]
  )
  const hasAnyCandidates = candidates.length > 0
  const initialLoading = loading && !hasAnyCandidates
  const activeBaseRows =
    resolvedActiveView === 'hidden' ? hiddenCandidates : groups[resolvedActiveView]
  const activeRows = useMemo(
    () =>
      sortWorkspaceCleanupCandidates(
        filterWorkspaceCleanupCandidates(
          activeBaseRows,
          filters,
          reviewInfoByWorktreeId,
          scan?.scannedAt ?? Date.now()
        ),
        sortKey,
        sortDirection,
        reviewInfoByWorktreeId
      ),
    [activeBaseRows, filters, reviewInfoByWorktreeId, scan?.scannedAt, sortDirection, sortKey]
  )
  const activeRowIds = useMemo(
    () => new Set(activeRows.map((candidate) => candidate.worktreeId)),
    [activeRows]
  )
  const activeFilters = hasActiveWorkspaceCleanupFilters(filters)
  const selectedCandidates = useMemo(() => {
    const byId = new Map(activeRows.map((candidate) => [candidate.worktreeId, candidate]))
    return [...selectedIds]
      .map((id) => byId.get(id))
      .filter(
        (candidate): candidate is WorkspaceCleanupCandidate =>
          candidate != null &&
          canQueueWorkspaceCleanupCandidate(candidate) &&
          !deletingWorktreeIds.has(candidate.worktreeId)
      )
  }, [activeRows, deletingWorktreeIds, selectedIds])
  useEffect(() => {
    if (!open || confirming) {
      return
    }
    // Why: destructive selection must stay scoped to the rows the user can
    // currently review after tier/filter changes.
    setSelectedIds((current) => {
      const next = new Set(
        [...current].filter((id) => activeRowIds.has(id) && !deletingWorktreeIds.has(id))
      )
      return next.size === current.size ? current : next
    })
  }, [activeRowIds, confirming, deletingWorktreeIds, open, setSelectedIds])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        closeModal()
      }
    },
    [closeModal]
  )

  const refresh = useCallback(() => {
    startWorkspaceCleanupScan({ notifyWhenReady: true })
  }, [startWorkspaceCleanupScan])

  const toggleExpandedRow = useCallback(
    (worktreeId: string) => {
      setExpandedRowIds((current) => toggleSetMember(current, worktreeId))
    },
    [setExpandedRowIds]
  )

  const toggleSelectedRow = useCallback(
    (worktreeId: string) => {
      setSelectedIds((current) => toggleSetMember(current, worktreeId))
    },
    [setSelectedIds]
  )

  // Why: stable per-row handlers so React.memo keeps unchanged CandidateRow
  // instances from re-rendering on scan stream-in and selection changes.
  const handleRemoveRow = useCallback(
    (candidate: WorkspaceCleanupCandidate) => {
      if (loading || removalInFlightRef.current) {
        return
      }
      setSelectedIds(new Set([candidate.worktreeId]))
      openConfirmRemove([candidate])
    },
    [loading, openConfirmRemove, removalInFlightRef, setSelectedIds]
  )

  const handleViewCandidate = useCallback(
    (candidate: WorkspaceCleanupCandidate) => {
      markCandidateViewed(candidate)
      closeModal()
      activateAndRevealWorktree(candidate.worktreeId)
    },
    [closeModal, markCandidateViewed]
  )

  const selectedCount = selectedCandidates.length

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(820px,90vh)] w-[calc(100vw-3rem)] max-w-[calc(100vw-3rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-3rem)] xl:w-[920px] xl:max-w-[920px]"
      >
        {!confirming ? (
          <>
            <DialogHeader className="border-b border-border px-5 py-4">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <DialogTitle className="text-base">
                    {translate(
                      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.b2c1331844',
                      'Delete Inactive Workspaces'
                    )}
                  </DialogTitle>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label={translate(
                          'auto.components.workspace.cleanup.WorkspaceCleanupDialog.7ae2ad30f4',
                          'Refresh'
                        )}
                        onClick={refresh}
                        disabled={loading}
                      >
                        <RefreshCcw className={cn('size-3.5', loading && 'animate-spin')} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>
                      {translate(
                        'auto.components.workspace.cleanup.WorkspaceCleanupDialog.7ae2ad30f4',
                        'Refresh'
                      )}
                    </TooltipContent>
                  </Tooltip>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={translate(
                      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.191f0bc98e',
                      'Close'
                    )}
                    onClick={() => closeModal()}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </div>
            </DialogHeader>

            {initialLoading ? (
              <div className="flex items-start gap-2 border-b border-border bg-muted/25 px-5 py-3">
                <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-foreground">
                    {translate(
                      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.7eee951968',
                      'Checking inactive workspaces'
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {translate(
                      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.47123d0108',
                      'Scanning inactive workspaces. You can close this and come back.'
                    )}
                  </div>
                  <div className="mt-1 text-xs font-medium text-muted-foreground">
                    {formatWorkspaceCleanupProgress(scanProgress)}
                  </div>
                </div>
              </div>
            ) : hasAnyCandidates ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/25 px-4 py-2.5">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <div className="min-w-0 text-sm font-medium text-foreground">
                    {selectedCount}{' '}
                    {translate(
                      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.ac5ba84cc1',
                      'selected'
                    )}
                  </div>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {eligibleRepos.length > 1 ? (
                    <div className="w-[220px] max-w-full">
                      <RepoMultiCombobox
                        repos={eligibleRepos}
                        selected={effectiveRepoSelection}
                        onChange={(next) => setRepoSelection(new Set(next))}
                        onSelectAll={() => setRepoSelection(new Set(eligibleRepoIds))}
                        triggerClassName="h-8 w-full rounded-md border border-border/60 bg-background px-2 text-xs font-medium shadow-xs hover:bg-accent/60"
                      />
                    </div>
                  ) : null}
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => openConfirmRemove(selectedCandidates)}
                    // Why: leaving the progress view no longer closes the dialog, so the
                    // list is reachable mid-batch; a second batch would silently no-op.
                    disabled={
                      selectedCount === 0 || loading || removalProgress !== null || removalInFlight
                    }
                  >
                    <Trash2 className="size-3.5" />
                    {translate(
                      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.b771c92598',
                      'Delete selected'
                    )}
                  </Button>
                </div>
              </div>
            ) : null}

            {loading && scan && hasAnyCandidates ? (
              <div className="border-b border-border bg-muted/25 px-5 py-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 shrink-0 animate-spin" />
                  <span>
                    {translate(
                      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.9a3be9f2df',
                      'Scanning inactive workspaces. New rows appear here as they finish. You can close this and come back.'
                    )}
                  </span>
                  <span className="font-medium text-foreground">
                    {formatWorkspaceCleanupProgress(scanProgress)}
                  </span>
                </div>
              </div>
            ) : null}

            {error ? (
              <div className="border-b border-destructive/30 bg-destructive/10 px-5 py-2 text-xs text-destructive">
                {error}
              </div>
            ) : scanNoticeMessage ? (
              <div className="flex items-center gap-2 border-b border-border bg-muted/25 px-5 py-2 text-xs text-muted-foreground">
                <AlertTriangle className="size-3.5 shrink-0" />
                <span>{scanNoticeMessage}</span>
              </div>
            ) : null}

            {estimateMismatchNotice ? (
              <div className="flex items-start gap-2 border-b border-border bg-muted/25 px-5 py-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span>{estimateMismatchNotice}</span>
              </div>
            ) : null}

            <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[185px_minmax(0,1fr)]">
              <CleanupViewNav
                activeView={resolvedActiveView}
                counts={cleanupViewCounts}
                onViewChange={setActiveView}
              />
              <div className="flex min-h-0 min-w-0 flex-col border-t border-border md:border-l md:border-t-0">
                {filteredCandidates.length > 0 ? (
                  <WorkspaceCleanupFilterToolbar
                    filters={filters}
                    showRestoreIgnored={
                      resolvedActiveView === 'hidden' && hiddenCandidates.length > 0
                    }
                    sortKey={sortKey}
                    sortDirection={sortDirection}
                    onFiltersChange={setFilters}
                    onSortKeyChange={setSortKey}
                    onSortDirectionChange={setSortDirection}
                    onRestoreIgnored={() => void resetDismissals()}
                  />
                ) : null}
                <ScrollArea className="min-h-0 flex-1" viewportRef={setRowsScrollElement}>
                  <div>
                    {initialLoading ? <SkeletonRows /> : null}
                    {!loading && scan && candidates.length === 0 && !scanNoticeMessage ? (
                      <EmptyState
                        title={translate(
                          'auto.components.workspace.cleanup.WorkspaceCleanupDialog.d3eef9463d',
                          'No inactive workspaces to delete.'
                        )}
                      />
                    ) : null}
                    {!loading && scan && candidates.length === 0 && scanNoticeMessage ? (
                      <EmptyState
                        title={translate(
                          'auto.components.workspace.cleanup.WorkspaceCleanupDialog.97c772c4fe',
                          'No inactive workspaces found in checked repositories.'
                        )}
                      />
                    ) : null}
                    {!loading &&
                    scan &&
                    candidates.length > 0 &&
                    filteredCandidates.length === 0 ? (
                      <EmptyState
                        title={translate(
                          'auto.components.workspace.cleanup.WorkspaceCleanupDialog.a19040cd67',
                          'No inactive workspaces match the selected repos.'
                        )}
                        actionLabel="Show all repos"
                        onAction={() => setRepoSelection(new Set(eligibleRepoIds))}
                      />
                    ) : null}
                    {!loading &&
                    scan &&
                    filteredCandidates.length > 0 &&
                    visibleCandidates.length === 0 ? (
                      <EmptyState
                        title={translate(
                          'auto.components.workspace.cleanup.WorkspaceCleanupDialog.4719327c9c',
                          'All cleanup suggestions are ignored.'
                        )}
                        actionLabel="Review ignored workspaces"
                        onAction={() => setActiveView('hidden')}
                      />
                    ) : null}
                    {!loading &&
                    scan &&
                    activeRows.length === 0 &&
                    activeBaseRows.length > 0 &&
                    activeFilters ? (
                      <EmptyState
                        title={translate(
                          'auto.components.workspace.cleanup.WorkspaceCleanupDialog.3d957ff117',
                          'No workspaces match these filters.'
                        )}
                        actionLabel={translate(
                          'auto.components.workspace.cleanup.WorkspaceCleanupDialog.e94b1f8bb4',
                          'Clear filters'
                        )}
                        onAction={() => setFilters(DEFAULT_WORKSPACE_CLEANUP_FILTERS)}
                      />
                    ) : null}
                    {!loading &&
                    scan &&
                    activeRows.length === 0 &&
                    visibleCandidates.length > 0 &&
                    !activeFilters ? (
                      <EmptyState
                        title={translate(
                          'auto.components.workspace.cleanup.WorkspaceCleanupDialog.f68d538c63',
                          'No workspaces in this cleanup set.'
                        )}
                      />
                    ) : null}
                    <WorkspaceCleanupCandidateList
                      rows={activeRows}
                      scrollElement={rowsScrollElement}
                      renderRow={(candidate, index) => (
                        <CandidateRow
                          key={candidate.worktreeId}
                          candidate={candidate}
                          reviewInfo={
                            reviewInfoByWorktreeId.get(candidate.worktreeId) ?? EMPTY_REVIEW_INFO
                          }
                          last={activeRows.length > 1 && index === activeRows.length - 1}
                          expanded={expandedRowIds.has(candidate.worktreeId)}
                          lastActivityLabel={formatRelativeTime(candidate.lastActivityAt)}
                          deletionPhase={deletionPhaseByWorktreeId[candidate.worktreeId]}
                          removing={
                            loading ||
                            removalInFlight ||
                            deletingWorktreeIds.has(candidate.worktreeId)
                          }
                          selected={
                            selectedIds.has(candidate.worktreeId) &&
                            !loading &&
                            !deletingWorktreeIds.has(candidate.worktreeId)
                          }
                          failure={rowFailures[candidate.worktreeId]}
                          onToggleExpanded={toggleExpandedRow}
                          onToggleSelected={toggleSelectedRow}
                          onView={handleViewCandidate}
                          onIgnore={ignoreCandidate}
                          onRemove={handleRemoveRow}
                        />
                      )}
                    />
                  </div>
                </ScrollArea>
              </div>
            </div>
          </>
        ) : (
          <ConfirmRemove
            candidates={confirmCandidates}
            reviewInfoByWorktreeId={reviewInfoByWorktreeId}
            progress={removalProgress}
            onBack={backToWorkspaceCleanupList}
            onCancel={cancelConfirmRemove}
            onConfirm={confirmRemove}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function WorkspaceCleanupFilterToolbar({
  filters,
  showRestoreIgnored,
  sortKey,
  sortDirection,
  onFiltersChange,
  onSortKeyChange,
  onSortDirectionChange,
  onRestoreIgnored
}: {
  filters: WorkspaceCleanupFilters
  showRestoreIgnored: boolean
  sortKey: WorkspaceCleanupSortKey
  sortDirection: WorkspaceCleanupSortDirection
  onFiltersChange: (filters: WorkspaceCleanupFilters) => void
  onSortKeyChange: (sortKey: WorkspaceCleanupSortKey) => void
  onSortDirectionChange: (direction: WorkspaceCleanupSortDirection) => void
  onRestoreIgnored: () => void
}): React.JSX.Element {
  const updateFilter = <K extends keyof WorkspaceCleanupFilters>(
    key: K,
    value: WorkspaceCleanupFilters[K]
  ): void => {
    onFiltersChange({ ...filters, [key]: value })
  }
  const hasHiddenControls = hasActiveWorkspaceCleanupPanelControls(filters, sortKey, sortDirection)
  const resetPanelControls = (): void => {
    onFiltersChange({
      ...filters,
      time: 'all',
      review: 'all',
      git: 'all',
      context: 'all'
    })
    onSortKeyChange('activity')
    onSortDirectionChange('asc')
  }

  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted/15 px-3 py-2">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.query}
          onChange={(event) => updateFilter('query', event.target.value)}
          placeholder={translate(
            'auto.components.workspace.cleanup.WorkspaceCleanupDialog.searchPlaceholder',
            'Search workspaces'
          )}
          className="h-8 pl-8 text-xs"
        />
      </div>
      <DropdownMenu modal={false}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon-sm"
                type="button"
                aria-label={translate(
                  'auto.components.workspace.cleanup.WorkspaceCleanupDialog.efb3843e75',
                  'Filter and sort workspaces'
                )}
                className="relative shrink-0"
              >
                <SlidersHorizontal className="size-3.5" />
                {hasHiddenControls ? (
                  <span
                    aria-hidden="true"
                    className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary"
                  />
                ) : null}
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.efb3843e75',
              'Filter and sort workspaces'
            )}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" sideOffset={6} className="w-64 pb-2">
          <DropdownMenuLabel>
            {translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.93b7381d50',
              'Filters'
            )}
          </DropdownMenuLabel>
          <WorkspaceCleanupMenuSub<WorkspaceCleanupTimeFilter>
            label={translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.ageFilter',
              'Age'
            )}
            value={filters.time}
            options={[
              ['all', 'Any age'],
              ['30d', '30d+'],
              ['90d', '90d+'],
              ['archived', 'Archived']
            ]}
            onChange={(value) => updateFilter('time', value)}
          />
          <WorkspaceCleanupMenuSub<WorkspaceCleanupReviewFilter>
            label={translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.reviewFilter',
              'Review'
            )}
            value={filters.review}
            options={[
              ['all', 'Any review'],
              ['no-review', 'No PR/MR'],
              ['has-review', 'Has PR/MR'],
              ['open-review', 'Open'],
              ['closed-review', 'Closed']
            ]}
            onChange={(value) => updateFilter('review', value)}
          />
          <WorkspaceCleanupMenuSub<WorkspaceCleanupGitFilter>
            label={translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.gitFilter',
              'Git'
            )}
            value={filters.git}
            options={[
              ['all', 'Any git'],
              ['clean', 'Clean'],
              ['dirty', 'Dirty'],
              ['unpushed', 'Unpushed'],
              ['unknown', 'Unknown']
            ]}
            onChange={(value) => updateFilter('git', value)}
          />
          <WorkspaceCleanupMenuSub<WorkspaceCleanupContextFilter>
            label={translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.contextFilter',
              'Context'
            )}
            value={filters.context}
            options={[
              ['all', 'Any context'],
              ['has-context', 'Has context'],
              ['no-context', 'No context']
            ]}
            onChange={(value) => updateFilter('context', value)}
          />
          <DropdownMenuSeparator />
          <DropdownMenuLabel>
            {translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.a615e24679',
              'Sort'
            )}
          </DropdownMenuLabel>
          <WorkspaceCleanupMenuSub<WorkspaceCleanupSortKey>
            label={translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.sortBy',
              'Sort by'
            )}
            value={sortKey}
            options={[
              ['activity', 'Activity'],
              ['name', 'Name'],
              ['repo', 'Repo'],
              ['review', 'Review'],
              ['git', 'Git']
            ]}
            onChange={onSortKeyChange}
          />
          <WorkspaceCleanupMenuSub<WorkspaceCleanupSortDirection>
            label={translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.sortDirection',
              'Direction'
            )}
            value={sortDirection}
            options={[
              ['asc', 'Ascending'],
              ['desc', 'Descending']
            ]}
            onChange={onSortDirectionChange}
          />
          {showRestoreIgnored ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onRestoreIgnored}>
                {translate(
                  'auto.components.workspace.cleanup.WorkspaceCleanupDialog.aaee139eab',
                  'Restore ignored suggestions'
                )}
              </DropdownMenuItem>
            </>
          ) : null}
          {hasHiddenControls ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={resetPanelControls}>
                {translate(
                  'auto.components.workspace.cleanup.WorkspaceCleanupDialog.e94b1f8bb4',
                  'Clear filters'
                )}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function WorkspaceCleanupMenuSub<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
}): React.JSX.Element {
  const valueLabel = options.find(([optionValue]) => optionValue === value)?.[1] ?? value
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
          <span className="truncate">{label}</span>
          <span className="truncate text-[11px] font-medium text-muted-foreground">
            {valueLabel}
          </span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-44">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
          {options.map(([optionValue, optionLabel]) => (
            <DropdownMenuRadioItem
              key={optionValue}
              value={optionValue}
              onSelect={(event) => event.preventDefault()}
            >
              {optionLabel}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function CleanupViewNav({
  activeView,
  counts,
  onViewChange
}: {
  activeView: WorkspaceCleanupView
  counts: WorkspaceCleanupViewCounts
  onViewChange: (view: WorkspaceCleanupView) => void
}): React.JSX.Element {
  const items: { view: WorkspaceCleanupView; label: string }[] = [
    {
      view: 'ready',
      label: translate(
        'auto.components.workspace.cleanup.WorkspaceCleanupDialog.4b93a235d8',
        'Suggested'
      )
    },
    {
      view: 'review',
      label: translate(
        'auto.components.workspace.cleanup.WorkspaceCleanupDialog.d1094dd529',
        'Needs review'
      )
    },
    {
      view: 'protected',
      label: translate(
        'auto.components.workspace.cleanup.WorkspaceCleanupDialog.c4f4782c02',
        'Not suggested'
      )
    },
    {
      view: 'hidden',
      label: translate(
        'auto.components.workspace.cleanup.WorkspaceCleanupDialog.e8b3741ff7',
        'Ignored'
      )
    }
  ]

  return (
    <aside className="border-t border-border bg-background md:border-t-0">
      <div className="space-y-1 p-2">
        {items.map((item) => (
          <button
            key={item.view}
            type="button"
            className={cn(
              'flex h-8 w-full items-center justify-between gap-2 rounded-md px-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
              activeView === item.view && 'bg-accent text-accent-foreground'
            )}
            onClick={() => onViewChange(item.view)}
          >
            <span className="truncate">{item.label}</span>
            <span className="tabular-nums text-muted-foreground">{counts[item.view]}</span>
          </button>
        ))}
      </div>
    </aside>
  )
}

function ConfirmRemove({
  candidates,
  reviewInfoByWorktreeId,
  progress,
  onBack,
  onCancel,
  onConfirm
}: {
  candidates: WorkspaceCleanupCandidate[]
  reviewInfoByWorktreeId: ReadonlyMap<string, WorkspaceCleanupReviewInfo>
  progress: WorkspaceCleanupRemovalProgress | null
  onBack: () => void
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const count = candidates.length
  const deleting = progress !== null
  const progressValue = progress
    ? Math.min(100, Math.max(0, (progress.processedCount / progress.totalCount) * 100))
    : 0
  return (
    <>
      <DialogHeader className="border-b border-border px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-destructive/25 bg-destructive/10 text-destructive">
              {deleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <AlertTriangle className="size-4" />
              )}
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-base">
                {deleting
                  ? translate(
                      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.deletingCount',
                      'Deleting workspaces: {{value0}}',
                      { value0: count }
                    )
                  : translate(
                      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.deleteCount',
                      'Delete workspaces: {{value0}}?',
                      { value0: count }
                    )}
              </DialogTitle>
              <DialogDescription className="mt-1.5 text-xs leading-5">
                {deleting
                  ? translate(
                      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.1d3503357d',
                      'You can close this and come back while deletion continues.'
                    )
                  : translate(
                      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.38ca0b1400',
                      "This permanently deletes their local files. You can't undo this."
                    )}
              </DialogDescription>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.74f6c16279',
              'Back'
            )}
            onClick={onBack}
          >
            <X className="size-4" />
          </Button>
        </div>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        {progress ? (
          <div className="border-b border-border bg-muted/25 px-5 py-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
              <span className="font-medium text-foreground">
                {formatWorkspaceCleanupRemovalProgress(progress)}
              </span>
            </div>
            <Progress value={progressValue} className="mt-2 h-1.5" />
          </div>
        ) : null}
        <div className="flex items-center justify-between border-b border-border px-5 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.selectedForDeletionCount',
              'Selected for deletion: {{value0}}',
              { value0: count }
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.592fbab446',
              'Sorted by oldest activity'
            )}
          </div>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {candidates.map((candidate, index) => (
            <ConfirmRemoveRow
              key={candidate.worktreeId}
              candidate={candidate}
              reviewInfo={reviewInfoByWorktreeId.get(candidate.worktreeId) ?? EMPTY_REVIEW_INFO}
              last={index === candidates.length - 1}
            />
          ))}
        </ScrollArea>
      </div>
      <DialogFooter className="border-t border-border px-5 py-3">
        <Button variant="outline" onClick={onCancel}>
          {deleting
            ? translate(
                'auto.components.workspace.cleanup.WorkspaceCleanupDialog.191f0bc98e',
                'Close'
              )
            : translate(
                'auto.components.workspace.cleanup.WorkspaceCleanupDialog.b6bae1eed1',
                'Cancel'
              )}
        </Button>
        {!deleting ? (
          <Button variant="destructive" onClick={onConfirm} disabled={count === 0}>
            <Trash2 className="size-4" />
            {translate(
              'auto.components.workspace.cleanup.WorkspaceCleanupDialog.deleteButtonCount',
              'Delete {{value0}}',
              { value0: count }
            )}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  )
}

function ConfirmRemoveRow({
  candidate,
  reviewInfo,
  last
}: {
  candidate: WorkspaceCleanupCandidate
  reviewInfo: WorkspaceCleanupReviewInfo
  last: boolean
}): React.JSX.Element {
  const dirtyLabel = getDirtyGitLabel(candidate)
  const branchDiffersFromName = candidate.branch !== candidate.displayName
  const contextPillLabel = getContextPillLabel(candidate)
  const showGitMetadataChip = shouldShowGitMetadataChip(candidate)
  const status = getCandidateStatus(candidate)
  return (
    <div className={cn('border-b border-border/60 px-5 py-2.5', last && 'border-b-0')}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="min-w-0 truncate text-sm font-medium">{candidate.displayName}</span>
        <span className="text-xs text-muted-foreground">
          {translate(
            'auto.components.workspace.cleanup.WorkspaceCleanupDialog.352f15d6fc',
            'Last active'
          )}{' '}
          {formatRelativeTime(candidate.lastActivityAt)}
        </span>
        <StatusPill tone={status.tone}>{status.label}</StatusPill>
        {reviewInfo.label ? (
          <StatusPill tone={getReviewPillTone(reviewInfo)}>{reviewInfo.label}</StatusPill>
        ) : null}
        {contextPillLabel ? <StatusPill>{contextPillLabel}</StatusPill> : null}
        {dirtyLabel && showGitMetadataChip ? (
          <StatusPill tone="destructive">{dirtyLabel}</StatusPill>
        ) : null}
      </div>
      <div className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{candidate.repoName}</span>
        {branchDiffersFromName ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate font-mono">{candidate.branch}</span>
          </>
        ) : null}
      </div>
      <div className="mt-0.5 min-w-0 truncate font-mono text-[11px] text-muted-foreground/80">
        {candidate.path}
      </div>
    </div>
  )
}

function hasActiveWorkspaceCleanupFilters(filters: WorkspaceCleanupFilters): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.time !== 'all' ||
    filters.review !== 'all' ||
    filters.git !== 'all' ||
    filters.context !== 'all'
  )
}

function hasActiveWorkspaceCleanupPanelControls(
  filters: WorkspaceCleanupFilters,
  sortKey: WorkspaceCleanupSortKey,
  sortDirection: WorkspaceCleanupSortDirection
): boolean {
  return (
    filters.time !== 'all' ||
    filters.review !== 'all' ||
    filters.git !== 'all' ||
    filters.context !== 'all' ||
    sortKey !== 'activity' ||
    sortDirection !== 'asc'
  )
}

function formatWorkspaceCleanupRemovalProgress(progress: WorkspaceCleanupRemovalProgress): string {
  const deletedText = translate(
    'auto.components.workspace.cleanup.WorkspaceCleanupDialog.4c2990886e',
    '{{value0}}/{{value1}} deleted',
    {
      value0: progress.removedCount,
      value1: progress.totalCount
    }
  )
  if (progress.failedCount === 0) {
    return deletedText
  }
  return translate(
    'auto.components.workspace.cleanup.WorkspaceCleanupDialog.86ba852118',
    '{{value0}}, {{value1}} failed',
    {
      value0: deletedText,
      value1: progress.failedCount
    }
  )
}

function formatWorkspaceCleanupProgress(progress: WorkspaceCleanupScanProgress | null): string {
  if (!progress || progress.scannedWorktreeCount === 0) {
    return translate(
      'auto.components.workspace.cleanup.WorkspaceCleanupDialog.4cc5b73efe',
      'Finding inactive workspaces...'
    )
  }
  return translate(
    'auto.components.workspace.cleanup.WorkspaceCleanupDialog.7b7bde5181',
    'Checked workspaces so far: {{value0}}',
    {
      value0: progress.scannedWorktreeCount
    }
  )
}

function SkeletonRows(): React.JSX.Element {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="h-24 animate-pulse rounded-lg border border-border bg-muted/35"
        />
      ))}
    </div>
  )
}

function EmptyState({
  title,
  actionLabel,
  onAction
}: {
  title: string
  actionLabel?: string
  onAction?: () => void
}): React.JSX.Element {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-lg border border-border bg-muted/20 text-sm text-muted-foreground">
      <span>{title}</span>
      {actionLabel && onAction ? (
        <Button variant="outline" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  )
}

function toggleSetMember(current: Set<string>, value: string): Set<string> {
  const next = new Set(current)
  if (next.has(value)) {
    next.delete(value)
  } else {
    next.add(value)
  }
  return next
}
