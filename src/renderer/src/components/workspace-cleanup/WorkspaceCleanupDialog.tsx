/* eslint-disable max-lines */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  EyeOff,
  Loader2,
  Minus,
  RefreshCcw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import {
  canQueueWorkspaceCleanupCandidate,
  type WorkspaceCleanupBlocker,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupScanError,
  type WorkspaceCleanupTier
} from '../../../../shared/workspace-cleanup'

const TIER_LABELS: Record<WorkspaceCleanupTier, string> = {
  ready: 'Suggested cleanup',
  review: 'Needs a closer look',
  protected: 'Not suggested for cleanup'
}

type CleanupView = WorkspaceCleanupTier | 'hidden'

const BLOCKER_LABELS: Record<WorkspaceCleanupBlocker, string> = {
  'main-worktree': 'Main workspace',
  'folder-repo': 'Folder project',
  pinned: 'Pinned',
  'active-workspace': 'Active workspace',
  'running-terminal': 'Running terminal process',
  'terminal-liveness-unknown': 'Terminal liveness unknown',
  'dirty-editor-buffer': 'Unsaved editor buffer',
  'volatile-local-context': 'Volatile local context',
  'recent-visible-context': 'Recently visited tabs',
  'live-agent': 'Active agent',
  'ssh-disconnected': 'Remote unavailable',
  'git-status-error': 'Git status unavailable',
  'dirty-files': 'Changed files',
  'unpushed-commits': 'Unpushed commits',
  'unknown-base': 'Could not verify unpushed commits',
  dismissed: 'Ignored'
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
    return `Could not check ${repoName}: ${formatScanErrorReason(error.message)}. Some old workspaces may be missing. Refresh to try again.`
  }
  const repoNames = visibleErrors
    .slice(0, 3)
    .map((error) => formatScanErrorRepoName(error, repoNameById))
    .join(', ')
  const moreCount = visibleErrors.length - 3
  const suffix = moreCount > 0 ? `, +${moreCount} more` : ''
  return `Could not check ${visibleErrors.length} repositories (${repoNames}${suffix}). Some old workspaces may be missing. Refresh to try again.`
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

function isOldWorkspaceCandidate(candidate: WorkspaceCleanupCandidate): boolean {
  if (candidate.blockers.includes('main-worktree') || candidate.blockers.includes('folder-repo')) {
    return false
  }
  return candidate.reasons.includes('archived') || candidate.reasons.includes('idle-clean')
}

function compareCleanupCandidates(
  a: WorkspaceCleanupCandidate,
  b: WorkspaceCleanupCandidate
): number {
  const priorityA = getCleanupCandidatePriority(a)
  const priorityB = getCleanupCandidatePriority(b)
  if (priorityA !== priorityB) {
    return priorityA - priorityB
  }
  return a.lastActivityAt - b.lastActivityAt
}

function getCleanupCandidatePriority(candidate: WorkspaceCleanupCandidate): number {
  if (candidate.tier === 'ready') {
    return 0
  }
  if (candidate.reasons.length > 0) {
    return 1
  }
  if (isOldWorkspaceCandidate(candidate)) {
    return 2
  }
  return 3
}

export default function WorkspaceCleanupDialog(): React.JSX.Element {
  const activeModal = useAppStore((s) => s.activeModal)
  const closeModal = useAppStore((s) => s.closeModal)
  const scan = useAppStore((s) => s.workspaceCleanupScan)
  const loading = useAppStore((s) => s.workspaceCleanupLoading)
  const error = useAppStore((s) => s.workspaceCleanupError)
  const repos = useAppStore((s) => s.repos)
  const scanWorkspaceCleanup = useAppStore((s) => s.scanWorkspaceCleanup)
  const markCandidateViewed = useAppStore((s) => s.markWorkspaceCleanupCandidateViewed)
  const dismissCandidates = useAppStore((s) => s.dismissWorkspaceCleanupCandidates)
  const resetDismissals = useAppStore((s) => s.resetWorkspaceCleanupDismissals)
  const removeCandidates = useAppStore((s) => s.removeWorkspaceCleanupCandidates)

  const open = activeModal === 'workspace-cleanup'
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [activeView, setActiveView] = useState<CleanupView>('ready')
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [rowFailures, setRowFailures] = useState<Record<string, string>>({})

  useEffect(() => {
    if (open) {
      setRowFailures({})
      setActiveView('ready')
      void scanWorkspaceCleanup().catch((err: unknown) => {
        toast.error('Workspace cleanup scan failed', {
          description: err instanceof Error ? err.message : String(err)
        })
      })
    }
  }, [open, scanWorkspaceCleanup])

  const candidates = useMemo(() => scan?.candidates ?? [], [scan?.candidates])

  useEffect(() => {
    if (!open || !scan) {
      return
    }
    setSelectedIds(
      new Set(
        candidates
          .filter((candidate) => candidate.selectedByDefault)
          .map((candidate) => candidate.worktreeId)
      )
    )
    setConfirming(false)
  }, [open, scan, scan?.scannedAt, candidates])

  const visibleCandidates = useMemo(() => {
    const rows = candidates.filter((candidate) => !candidate.blockers.includes('dismissed'))
    return [...rows].sort(compareCleanupCandidates)
  }, [candidates])
  const hiddenCandidates = useMemo(
    () =>
      candidates
        .filter((candidate) => candidate.blockers.includes('dismissed'))
        .sort(compareCleanupCandidates),
    [candidates]
  )
  const groups = useMemo(
    () => ({
      ready: visibleCandidates.filter((candidate) => candidate.tier === 'ready'),
      review: visibleCandidates.filter((candidate) => candidate.tier === 'review'),
      protected: visibleCandidates.filter((candidate) => candidate.tier === 'protected')
    }),
    [visibleCandidates]
  )
  const selectedCandidates = useMemo(() => {
    const byId = new Map(candidates.map((candidate) => [candidate.worktreeId, candidate]))
    return [...selectedIds]
      .map((id) => byId.get(id))
      .filter(
        (candidate): candidate is WorkspaceCleanupCandidate =>
          candidate != null && canQueueWorkspaceCleanupCandidate(candidate)
      )
  }, [candidates, selectedIds])

  const hiddenByKeepCount = candidates.filter((candidate) =>
    candidate.blockers.includes('dismissed')
  ).length
  const repoNameById = useMemo(
    () => new Map(repos.map((repo) => [repo.id, repo.displayName || repo.path])),
    [repos]
  )
  const scanNoticeMessage = useMemo(
    () => formatScanNoticeMessage(scan?.errors ?? [], repoNameById),
    [repoNameById, scan?.errors]
  )
  const readyCount = groups.ready.length
  const oldCandidateCount = useMemo(
    () => candidates.filter(isOldWorkspaceCandidate).length,
    [candidates]
  )
  const initialLoading = loading && !scan
  const activeRows = activeView === 'hidden' ? hiddenCandidates : groups[activeView]
  const activeQueueableRows = useMemo(
    () => activeRows.filter(canQueueWorkspaceCleanupCandidate),
    [activeRows]
  )
  const activeQueueableSelected = useMemo(
    () => activeQueueableRows.filter((candidate) => selectedIds.has(candidate.worktreeId)).length,
    [activeQueueableRows, selectedIds]
  )
  const allActiveQueueableSelected =
    activeQueueableRows.length > 0 && activeQueueableSelected === activeQueueableRows.length
  const someActiveQueueableSelected = activeQueueableSelected > 0
  const activeSelectionState = allActiveQueueableSelected
    ? 'checked'
    : someActiveQueueableSelected
      ? 'mixed'
      : 'unchecked'

  useEffect(() => {
    if (!open || loading || !scan) {
      return
    }
    if (activeRows.length > 0) {
      return
    }
    if (readyCount > 0) {
      setActiveView('ready')
    } else if (groups.review.length > 0) {
      setActiveView('review')
    } else if (groups.protected.length > 0) {
      setActiveView('protected')
    } else if (hiddenCandidates.length > 0) {
      setActiveView('hidden')
    }
  }, [
    activeRows.length,
    groups.protected.length,
    groups.review.length,
    hiddenCandidates.length,
    loading,
    open,
    readyCount,
    scan
  ])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && !removing) {
        closeModal()
      }
    },
    [closeModal, removing]
  )

  const refresh = useCallback(() => {
    setRowFailures({})
    void scanWorkspaceCleanup().catch((err: unknown) => {
      toast.error('Workspace cleanup scan failed', {
        description: err instanceof Error ? err.message : String(err)
      })
    })
  }, [scanWorkspaceCleanup])

  const toggleActiveSelection = useCallback(() => {
    if (activeQueueableRows.length === 0) {
      return
    }
    setSelectedIds((current) => {
      const next = new Set(current)
      if (allActiveQueueableSelected) {
        for (const candidate of activeQueueableRows) {
          next.delete(candidate.worktreeId)
        }
      } else {
        for (const candidate of activeQueueableRows) {
          next.add(candidate.worktreeId)
        }
      }
      return next
    })
  }, [activeQueueableRows, allActiveQueueableSelected])

  const ignoreCandidate = useCallback(
    (candidate: WorkspaceCleanupCandidate) => {
      void dismissCandidates([candidate])
        .then(() => {
          setSelectedIds((current) => {
            const next = new Set(current)
            next.delete(candidate.worktreeId)
            return next
          })
        })
        .catch((err: unknown) => {
          toast.error('Could not ignore cleanup suggestion', {
            description: err instanceof Error ? err.message : String(err)
          })
        })
    },
    [dismissCandidates]
  )

  const confirmRemove = useCallback(async () => {
    if (selectedCandidates.length === 0) {
      return
    }
    setRemoving(true)
    setRowFailures({})
    try {
      const result = await removeCandidates(
        selectedCandidates.map((candidate) => candidate.worktreeId)
      )
      const nextFailures: Record<string, string> = {}
      for (const failure of result.failures) {
        nextFailures[failure.worktreeId] = failure.message
      }
      setRowFailures(nextFailures)
      setSelectedIds((current) => {
        const next = new Set(current)
        for (const id of result.removedIds) {
          next.delete(id)
        }
        return next
      })
      if (result.removedIds.length > 0) {
        toast.success(
          `Removed ${result.removedIds.length} workspace${result.removedIds.length === 1 ? '' : 's'}`
        )
      }
      if (result.failures.length > 0) {
        toast.error(
          `${result.failures.length} workspace${result.failures.length === 1 ? '' : 's'} could not be removed`
        )
      } else {
        setConfirming(false)
      }
    } finally {
      setRemoving(false)
    }
  }, [removeCandidates, selectedCandidates])

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
                  <DialogTitle className="text-base">Clean Up Old Workspaces</DialogTitle>
                  <DialogDescription className="mt-1 text-xs">
                    Review old workspaces before deleting their local files and Orca state.
                  </DialogDescription>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label="Refresh"
                        onClick={refresh}
                        disabled={loading}
                      >
                        <RefreshCcw className={cn('size-3.5', loading && 'animate-spin')} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>
                      Refresh
                    </TooltipContent>
                  </Tooltip>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Close"
                    onClick={() => closeModal()}
                    disabled={removing}
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              </div>
            </DialogHeader>

            {initialLoading ? (
              <div className="flex items-center gap-2 border-b border-border bg-muted/25 px-5 py-3 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Checking old workspaces
              </div>
            ) : oldCandidateCount > 0 || hiddenByKeepCount > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/25 px-4 py-2.5">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <div className="min-w-0 text-sm font-medium text-foreground">
                    {selectedCount} selected
                  </div>
                  {readyCount > 0 ? (
                    <StatusPill tone="ready">{readyCount} safe to remove</StatusPill>
                  ) : null}
                  {groups.review.length > 0 ? (
                    <StatusPill tone="review">{groups.review.length} need review</StatusPill>
                  ) : null}
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => setConfirming(true)}
                    disabled={selectedCount === 0}
                  >
                    <Trash2 className="size-3.5" />
                    Remove selected
                  </Button>
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

            <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[185px_minmax(0,1fr)]">
              <CleanupViewNav
                activeView={activeView}
                counts={{
                  ready: groups.ready.length,
                  review: groups.review.length,
                  protected: groups.protected.length,
                  hidden: hiddenByKeepCount
                }}
                onViewChange={setActiveView}
              />
              <div className="flex min-w-0 flex-col border-t border-border md:border-l md:border-t-0">
                <div className="flex min-h-10 items-center justify-between gap-3 border-b border-border px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {activeView !== 'hidden' && activeQueueableRows.length > 0 ? (
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={
                          activeSelectionState === 'mixed' ? 'mixed' : allActiveQueueableSelected
                        }
                        aria-label={
                          allActiveQueueableSelected
                            ? `Unselect all in ${TIER_LABELS[activeView]}`
                            : `Select all in ${TIER_LABELS[activeView]}`
                        }
                        onClick={toggleActiveSelection}
                        className="flex size-4 shrink-0 items-center justify-center rounded border border-border bg-background text-primary hover:bg-accent"
                      >
                        {activeSelectionState === 'checked' ? (
                          <Check className="size-3" strokeWidth={3} />
                        ) : activeSelectionState === 'mixed' ? (
                          <Minus className="size-3" strokeWidth={3} />
                        ) : null}
                      </button>
                    ) : null}
                    <div className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                      {activeView === 'hidden'
                        ? 'Ignored cleanup suggestions'
                        : TIER_LABELS[activeView]}
                    </div>
                  </div>
                  {activeView === 'hidden' && hiddenByKeepCount > 0 ? (
                    <Button
                      variant="link"
                      size="xs"
                      className="h-auto shrink-0 px-0 text-xs"
                      onClick={() => void resetDismissals()}
                    >
                      Restore ignored suggestions
                    </Button>
                  ) : (
                    <div className="shrink-0 text-xs text-muted-foreground">
                      Sorted by oldest activity
                    </div>
                  )}
                </div>
                <ScrollArea className="min-h-0 flex-1">
                  <div>
                    {initialLoading ? <SkeletonRows /> : null}
                    {!loading && scan && candidates.length === 0 && !scanNoticeMessage ? (
                      <EmptyState title="No old workspaces to clean up." />
                    ) : null}
                    {!loading && scan && candidates.length === 0 && scanNoticeMessage ? (
                      <EmptyState title="No old workspaces found in checked repositories." />
                    ) : null}
                    {!loading && scan && candidates.length > 0 && visibleCandidates.length === 0 ? (
                      <EmptyState
                        title="All cleanup suggestions are ignored."
                        actionLabel="Review ignored workspaces"
                        onAction={() => setActiveView('hidden')}
                      />
                    ) : null}
                    {!loading && scan && activeRows.length === 0 && visibleCandidates.length > 0 ? (
                      <EmptyState title="No workspaces in this cleanup set." />
                    ) : null}
                    {activeRows.map((candidate, index) => (
                      <CandidateRow
                        key={candidate.worktreeId}
                        candidate={candidate}
                        last={index === activeRows.length - 1}
                        selected={selectedIds.has(candidate.worktreeId)}
                        failure={rowFailures[candidate.worktreeId]}
                        onToggleSelected={(id) =>
                          setSelectedIds((current) => toggleSetMember(current, id))
                        }
                        onView={closeAndView}
                        onIgnore={ignoreCandidate}
                        onRemove={(candidate) => {
                          setSelectedIds(new Set([candidate.worktreeId]))
                          setConfirming(true)
                        }}
                      />
                    ))}
                  </div>
                </ScrollArea>
              </div>
            </div>
          </>
        ) : (
          <ConfirmRemove
            count={selectedCount}
            removing={removing}
            onCancel={() => setConfirming(false)}
            onConfirm={() => void confirmRemove()}
          />
        )}
      </DialogContent>
    </Dialog>
  )

  function closeAndView(candidate: WorkspaceCleanupCandidate): void {
    markCandidateViewed(candidate)
    closeModal()
    activateAndRevealWorktree(candidate.worktreeId)
  }
}

function StatusPill({
  children,
  tone = 'neutral'
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'ready' | 'review' | 'destructive'
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium',
        tone === 'neutral' && 'border-border bg-background text-muted-foreground',
        tone === 'ready' && 'border-border text-[var(--git-decoration-added)]',
        tone === 'review' && 'border-border text-[var(--git-decoration-modified)]',
        tone === 'destructive' && 'border-destructive/30 text-destructive'
      )}
    >
      {children}
    </span>
  )
}

function CleanupViewNav({
  activeView,
  counts,
  onViewChange
}: {
  activeView: CleanupView
  counts: Record<CleanupView, number>
  onViewChange: (view: CleanupView) => void
}): React.JSX.Element {
  const items: { view: CleanupView; label: string }[] = [
    { view: 'ready', label: 'Suggested' },
    { view: 'review', label: 'Needs review' },
    { view: 'protected', label: 'Not suggested' },
    { view: 'hidden', label: 'Ignored' }
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

function CandidateRow({
  candidate,
  last,
  selected,
  failure,
  onToggleSelected,
  onView,
  onIgnore,
  onRemove
}: {
  candidate: WorkspaceCleanupCandidate
  last: boolean
  selected: boolean
  failure?: string
  onToggleSelected: (worktreeId: string) => void
  onView: (candidate: WorkspaceCleanupCandidate) => void
  onIgnore: (candidate: WorkspaceCleanupCandidate) => void
  onRemove: (candidate: WorkspaceCleanupCandidate) => void
}): React.JSX.Element {
  const selectable = canQueueWorkspaceCleanupCandidate(candidate)
  const ignored = candidate.blockers.includes('dismissed')
  const blockers = candidate.blockers.map((blocker) => BLOCKER_LABELS[blocker])
  const contextDetails = formatContextDetails(candidate)
  const branchSafetyDetails = formatBranchSafetyDetails(candidate)
  const status = getCandidateStatus(candidate)

  return (
    <div
      className={cn(
        'group w-full border-b border-border/60 px-3 py-3 text-left text-foreground transition-colors hover:bg-accent/40',
        last && 'border-b-0'
      )}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1 md:grid-cols-[auto_minmax(0,1fr)_auto]">
        {selectable ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={selected}
            aria-label={`Select ${candidate.displayName}`}
            onClick={() => onToggleSelected(candidate.worktreeId)}
            className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-border bg-background text-primary hover:bg-accent"
          >
            {selected ? <Check className="size-3" strokeWidth={3} /> : null}
          </button>
        ) : (
          <div className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="min-w-0 truncate text-sm font-medium">{candidate.displayName}</span>
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
            <span className="text-xs text-muted-foreground">
              Last active {formatRelativeTime(candidate.lastActivityAt)}
            </span>
            {blockers.length > 0 ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {blockers.slice(0, 2).join(', ')}
              </span>
            ) : null}
          </div>
          <div className="mt-1 min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {candidate.path}
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="min-w-0 truncate">Repo {candidate.repoName}</span>
            <span className="min-w-0 truncate font-mono">Branch {candidate.branch}</span>
            <span>{formatGitStatus(candidate)}</span>
            {branchSafetyDetails.slice(0, 1).map((detail) => (
              <span key={detail}>{detail}</span>
            ))}
            {contextDetails ? <span className="min-w-0 truncate">{contextDetails}</span> : null}
          </div>
          {failure ? (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
              <AlertTriangle className="size-3.5" />
              {failure}
            </div>
          ) : null}
        </div>
        <div className="col-start-2 flex flex-wrap items-center gap-0.5 md:col-start-auto md:justify-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`View ${candidate.displayName}`}
                onClick={() => onView(candidate)}
              >
                <Search className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              View
            </TooltipContent>
          </Tooltip>
          {!ignored ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Ignore ${candidate.displayName}`}
                  onClick={() => onIgnore(candidate)}
                >
                  <EyeOff className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                Ignore
              </TooltipContent>
            </Tooltip>
          ) : null}
          {selectable ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Remove ${candidate.displayName}`}
                  className="text-destructive hover:text-destructive"
                  onClick={() => onRemove(candidate)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                Remove
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function getCandidateStatus(candidate: WorkspaceCleanupCandidate): {
  label: string
  tone: 'neutral' | 'ready' | 'review' | 'destructive'
} {
  if (candidate.blockers.includes('dismissed')) {
    return { label: 'Ignored', tone: 'neutral' }
  }
  if (candidate.tier === 'ready') {
    return { label: candidate.reasons.includes('archived') ? 'Archived' : 'Clean', tone: 'ready' }
  }
  if (candidate.blockers.length > 0) {
    return { label: BLOCKER_LABELS[candidate.blockers[0]], tone: 'neutral' }
  }
  if (candidate.git.upstreamAhead && candidate.git.upstreamAhead > 0) {
    return { label: 'Unpushed commits', tone: 'review' }
  }
  if (candidate.git.clean === false) {
    return { label: 'Dirty', tone: 'review' }
  }
  if (candidate.tier === 'review') {
    return { label: 'Review', tone: 'review' }
  }
  return { label: 'Not suggested', tone: 'neutral' }
}

function formatGitStatus(candidate: WorkspaceCleanupCandidate): string {
  if (candidate.git.clean === true) {
    return 'Clean git'
  }
  if (candidate.git.clean === false) {
    return 'Dirty git'
  }
  return 'Git unknown'
}

function formatBranchSafetyDetails(candidate: WorkspaceCleanupCandidate): string[] {
  const details: string[] = []
  if (candidate.git.upstreamAhead !== null) {
    details.push(
      candidate.git.upstreamAhead === 0
        ? 'No unpushed commits'
        : `${candidate.git.upstreamAhead} unpushed commit${
            candidate.git.upstreamAhead === 1 ? '' : 's'
          }`
    )
  }
  return details
}

function formatContextDetails(candidate: WorkspaceCleanupCandidate): string | null {
  const parts: string[] = []
  if (candidate.localContext.terminalTabCount > 0) {
    parts.push(
      `${candidate.localContext.terminalTabCount} terminal tab${
        candidate.localContext.terminalTabCount === 1 ? '' : 's'
      }`
    )
  }
  if (candidate.localContext.cleanEditorTabCount > 0) {
    parts.push(
      `${candidate.localContext.cleanEditorTabCount} editor tab${
        candidate.localContext.cleanEditorTabCount === 1 ? '' : 's'
      }`
    )
  }
  if (candidate.localContext.browserTabCount > 0) {
    parts.push(
      `${candidate.localContext.browserTabCount} browser tab${
        candidate.localContext.browserTabCount === 1 ? '' : 's'
      }`
    )
  }
  if (candidate.localContext.diffCommentCount > 0) {
    parts.push(
      `${candidate.localContext.diffCommentCount} diff note${
        candidate.localContext.diffCommentCount === 1 ? '' : 's'
      }`
    )
  }
  if (candidate.localContext.retainedDoneAgentCount > 0) {
    parts.push(
      `${candidate.localContext.retainedDoneAgentCount} completed agent${
        candidate.localContext.retainedDoneAgentCount === 1 ? '' : 's'
      }`
    )
  }
  return parts.length > 0 ? parts.join(', ') : null
}

function ConfirmRemove({
  count,
  removing,
  onCancel,
  onConfirm
}: {
  count: number
  removing: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <>
      <DialogHeader className="border-b border-border px-5 py-4">
        <DialogTitle className="text-base">
          Remove {count} workspace{count === 1 ? '' : 's'}?
        </DialogTitle>
        <DialogDescription className="mt-2 text-xs leading-5">
          Removing a workspace deletes its working tree folder, local Orca metadata, terminal
          history, browser workspace state, and the local branch when the existing git deletion path
          decides that branch is no longer used.
        </DialogDescription>
      </DialogHeader>
      <div className="flex-1 px-5 py-4 text-sm">
        Cleanup rechecks each selected workspace before deletion. Suggested rows use the normal
        git-safe removal path; not suggested rows may need forced worktree removal and are reported
        if they cannot be removed.
      </div>
      <DialogFooter className="border-t border-border px-5 py-3">
        <Button variant="outline" onClick={onCancel} disabled={removing}>
          Cancel
        </Button>
        <Button variant="destructive" onClick={onConfirm} disabled={removing || count === 0}>
          {removing ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
          Remove {count}
        </Button>
      </DialogFooter>
    </>
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
