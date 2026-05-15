/* eslint-disable max-lines */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Moon,
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
import { runSleepWorktrees } from '@/components/sidebar/sleep-worktree-flow'
import {
  canSelectWorkspaceCleanupCandidate,
  type WorkspaceCleanupBlocker,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupTier
} from '../../../../shared/workspace-cleanup'

const TIER_LABELS: Record<WorkspaceCleanupTier, string> = {
  ready: 'Suggested cleanup',
  review: 'Needs a closer look',
  protected: 'Not suggested for cleanup'
}

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
  dismissed: 'Hidden from cleanup'
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

function formatScanNoticeMessage(errors: { repoId: string; message: string }[]): string | null {
  if (errors.length === 0) {
    return null
  }
  const projectLabel = errors.length === 1 ? 'project' : 'projects'
  return `Could not check ${errors.length} ${projectLabel}. This list may be incomplete. Refresh to try again.`
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
  const scanWorkspaceCleanup = useAppStore((s) => s.scanWorkspaceCleanup)
  const markCandidateViewed = useAppStore((s) => s.markWorkspaceCleanupCandidateViewed)
  const dismissCandidates = useAppStore((s) => s.dismissWorkspaceCleanupCandidates)
  const resetDismissals = useAppStore((s) => s.resetWorkspaceCleanupDismissals)
  const removeCandidates = useAppStore((s) => s.removeWorkspaceCleanupCandidates)

  const open = activeModal === 'workspace-cleanup'
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [showKept, setShowKept] = useState(false)
  const [showSuggested, setShowSuggested] = useState(true)
  const [showReview, setShowReview] = useState(false)
  const [showProtected, setShowProtected] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [rowFailures, setRowFailures] = useState<Record<string, string>>({})

  useEffect(() => {
    if (open) {
      setRowFailures({})
      setShowSuggested(true)
      setShowReview(false)
      setShowProtected(false)
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
    const rows = showKept
      ? candidates
      : candidates.filter((candidate) => !candidate.blockers.includes('dismissed'))
    return [...rows].sort(compareCleanupCandidates)
  }, [candidates, showKept])
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
          candidate != null && canSelectWorkspaceCleanupCandidate(candidate)
      )
  }, [candidates, selectedIds])

  const hiddenByKeepCount = candidates.filter((candidate) =>
    candidate.blockers.includes('dismissed')
  ).length
  const scanNoticeMessage = useMemo(
    () => formatScanNoticeMessage(scan?.errors ?? []),
    [scan?.errors]
  )
  const readyCount = groups.ready.length
  const oldCandidateCount = useMemo(
    () => candidates.filter(isOldWorkspaceCandidate).length,
    [candidates]
  )
  const initialLoading = loading && !scan

  useEffect(() => {
    if (!open || loading || !scan) {
      return
    }
    if (readyCount === 0 && groups.review.length > 0) {
      setShowSuggested(false)
      setShowReview(true)
    }
  }, [groups.review.length, loading, open, readyCount, scan?.scannedAt, scan])

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

  const selectReady = useCallback(() => {
    setSelectedIds(
      new Set(
        visibleCandidates
          .filter((row) => row.tier === 'ready' && canSelectWorkspaceCleanupCandidate(row))
          .map((row) => row.worktreeId)
      )
    )
  }, [visibleCandidates])

  const keepSelected = useCallback(() => {
    if (selectedCandidates.length === 0) {
      return
    }
    void dismissCandidates(selectedCandidates)
      .then(() => {
        setSelectedIds(new Set())
        toast.success(
          `Hidden ${selectedCandidates.length} workspace${selectedCandidates.length === 1 ? '' : 's'}`
        )
      })
      .catch((err: unknown) => {
        toast.error('Could not hide selected workspaces', {
          description: err instanceof Error ? err.message : String(err)
        })
      })
  }, [dismissCandidates, selectedCandidates])

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
        className="flex h-[min(820px,90vh)] w-[calc(100vw-3rem)] max-w-[calc(100vw-3rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-3rem)] xl:w-[800px] xl:max-w-[800px]"
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
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/25 px-5 py-2.5">
                <div className="min-w-0 text-xs leading-5 text-muted-foreground">
                  {oldCandidateCount > 0 ? (
                    <>
                      <span className="font-medium text-foreground">{oldCandidateCount}</span> old
                      workspace{oldCandidateCount === 1 ? '' : 's'} found. {selectedCount} selected.
                    </>
                  ) : (
                    'No old workspaces found.'
                  )}
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {hiddenByKeepCount > 0 ? (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setShowKept((value) => !value)}
                    >
                      {showKept ? 'Hide hidden workspaces' : 'Show hidden workspaces'}
                    </Button>
                  ) : null}
                  {readyCount > 0 && selectedCount < readyCount ? (
                    <Button variant="ghost" size="xs" onClick={selectReady}>
                      Select all removable
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={keepSelected}
                    disabled={selectedCount === 0}
                  >
                    Hide selected
                  </Button>
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
            )}

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

            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-4 p-5">
                {initialLoading ? <SkeletonRows /> : null}
                {!loading && scan && candidates.length === 0 && !scanNoticeMessage ? (
                  <EmptyState title="No old workspaces to clean up." />
                ) : null}
                {!loading && scan && candidates.length === 0 && scanNoticeMessage ? (
                  <EmptyState title="No old workspaces found in checked projects." />
                ) : null}
                {!loading && scan && candidates.length > 0 && visibleCandidates.length === 0 ? (
                  <EmptyState
                    title="All cleanup suggestions are hidden."
                    actionLabel="Show hidden workspaces"
                    onAction={() => setShowKept(true)}
                  />
                ) : null}
                <CandidateGroup
                  tier="ready"
                  rows={groups.ready}
                  expanded={showSuggested}
                  onExpandedChange={setShowSuggested}
                  selectedIds={selectedIds}
                  rowFailures={rowFailures}
                  onToggleSelected={(id) =>
                    setSelectedIds((current) => toggleSetMember(current, id))
                  }
                  onView={closeAndView}
                  onKeep={(candidate) => void dismissCandidates([candidate])}
                  onSleep={(candidate) => void sleepAndRefresh(candidate.worktreeId, refresh)}
                  onRemove={(candidate) => {
                    setSelectedIds(new Set([candidate.worktreeId]))
                    setConfirming(true)
                  }}
                />
                <CandidateGroup
                  tier="review"
                  rows={groups.review}
                  expanded={showReview}
                  onExpandedChange={setShowReview}
                  selectedIds={selectedIds}
                  rowFailures={rowFailures}
                  onToggleSelected={(id) =>
                    setSelectedIds((current) => toggleSetMember(current, id))
                  }
                  onView={closeAndView}
                  onKeep={(candidate) => void dismissCandidates([candidate])}
                  onSleep={(candidate) => void sleepAndRefresh(candidate.worktreeId, refresh)}
                  onRemove={(candidate) => {
                    setSelectedIds(new Set([candidate.worktreeId]))
                    setConfirming(true)
                  }}
                />
                <CandidateGroup
                  tier="protected"
                  rows={groups.protected}
                  expanded={showProtected}
                  onExpandedChange={setShowProtected}
                  selectedIds={selectedIds}
                  rowFailures={rowFailures}
                  onToggleSelected={(id) =>
                    setSelectedIds((current) => toggleSetMember(current, id))
                  }
                  onView={closeAndView}
                  onKeep={(candidate) => void dismissCandidates([candidate])}
                  onSleep={(candidate) => void sleepAndRefresh(candidate.worktreeId, refresh)}
                  onRemove={(candidate) => {
                    setSelectedIds(new Set([candidate.worktreeId]))
                    setConfirming(true)
                  }}
                />
              </div>
            </ScrollArea>

            {hiddenByKeepCount > 0 ? (
              <div className="border-t border-border px-5 py-2">
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto px-0 text-xs"
                  onClick={() => void resetDismissals()}
                >
                  Show all cleanup suggestions
                </Button>
              </div>
            ) : null}
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

function CandidateGroup({
  tier,
  rows,
  expanded,
  onExpandedChange,
  selectedIds,
  rowFailures,
  onToggleSelected,
  onView,
  onKeep,
  onSleep,
  onRemove
}: {
  tier: WorkspaceCleanupTier
  rows: WorkspaceCleanupCandidate[]
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  selectedIds: Set<string>
  rowFailures: Record<string, string>
  onToggleSelected: (worktreeId: string) => void
  onView: (candidate: WorkspaceCleanupCandidate) => void
  onKeep: (candidate: WorkspaceCleanupCandidate) => void
  onSleep: (candidate: WorkspaceCleanupCandidate) => void
  onRemove: (candidate: WorkspaceCleanupCandidate) => void
}): React.JSX.Element | null {
  if (rows.length === 0) {
    return null
  }
  return (
    <section className="space-y-1.5">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground hover:text-foreground"
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span className="truncate">{TIER_LABELS[tier]}</span>
        <span className="text-muted-foreground/60">·</span>
        <span className="tabular-nums text-muted-foreground">{rows.length}</span>
      </button>
      {expanded ? (
        <div className="overflow-hidden rounded-md border border-border/60 bg-background">
          {rows.map((candidate, index) => (
            <CandidateRow
              key={candidate.worktreeId}
              candidate={candidate}
              last={index === rows.length - 1}
              selected={selectedIds.has(candidate.worktreeId)}
              failure={rowFailures[candidate.worktreeId]}
              onToggleSelected={onToggleSelected}
              onView={onView}
              onKeep={onKeep}
              onSleep={onSleep}
              onRemove={onRemove}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

function CandidateRow({
  candidate,
  last,
  selected,
  failure,
  onToggleSelected,
  onView,
  onKeep,
  onSleep,
  onRemove
}: {
  candidate: WorkspaceCleanupCandidate
  last: boolean
  selected: boolean
  failure?: string
  onToggleSelected: (worktreeId: string) => void
  onView: (candidate: WorkspaceCleanupCandidate) => void
  onKeep: (candidate: WorkspaceCleanupCandidate) => void
  onSleep: (candidate: WorkspaceCleanupCandidate) => void
  onRemove: (candidate: WorkspaceCleanupCandidate) => void
}): React.JSX.Element {
  const selectable = canSelectWorkspaceCleanupCandidate(candidate)
  const hasLiveSurfaces =
    candidate.localContext.terminalTabCount > 0 || candidate.localContext.browserTabCount > 0
  const blockers = candidate.blockers.map((blocker) => BLOCKER_LABELS[blocker])
  const contextDetails = formatContextDetails(candidate)
  const branchSafetyDetails = formatBranchSafetyDetails(candidate)
  const shouldShowSleep = candidate.tier !== 'ready' && hasLiveSurfaces

  return (
    <div
      className={cn(
        'group border-b border-border/60 px-3 py-2 text-foreground transition-colors hover:bg-accent/40',
        last && 'border-b-0'
      )}
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 gap-y-1 md:grid-cols-[auto_minmax(0,1fr)_auto]">
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={`Select ${candidate.displayName}`}
          disabled={!selectable}
          onClick={() => onToggleSelected(candidate.worktreeId)}
          className={cn(
            'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-border bg-background text-primary',
            selectable && 'hover:bg-accent',
            !selectable && 'opacity-40'
          )}
        >
          {selected ? <Check className="size-3" strokeWidth={3} /> : null}
        </button>
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="min-w-0 truncate text-sm font-medium">{candidate.displayName}</span>
            {candidate.reasons.includes('archived') ? (
              <span className="text-xs font-medium text-foreground">Archived</span>
            ) : null}
            <span className="text-xs text-muted-foreground">
              Last active {formatRelativeTime(candidate.lastActivityAt)}
            </span>
            {blockers.length > 0 ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {blockers.slice(0, 2).join(', ')}
              </span>
            ) : null}
          </div>
          <details className="mt-1 text-xs text-muted-foreground">
            <summary className="inline-flex cursor-pointer select-none items-center gap-1 hover:text-foreground">
              Details
            </summary>
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              <span className="min-w-0 truncate">Repo {candidate.repoName}</span>
              <span className="min-w-0 truncate font-mono">Branch {candidate.branch}</span>
              <span className="min-w-0 truncate font-mono sm:col-span-2">{candidate.path}</span>
              <span>
                {candidate.git.clean === true
                  ? 'Clean git'
                  : candidate.git.clean === false
                    ? 'Dirty'
                    : 'Git unknown'}
              </span>
              {branchSafetyDetails.map((detail) => (
                <span key={detail}>{detail}</span>
              ))}
              {contextDetails ? <span className="sm:col-span-2">{contextDetails}</span> : null}
              <span>Last activity {formatRelativeTime(candidate.lastActivityAt)}</span>
              {candidate.git.checkedAt ? (
                <span>Git checked {formatRelativeTime(candidate.git.checkedAt)}</span>
              ) : null}
            </div>
          </details>
          {failure ? (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-destructive">
              <AlertTriangle className="size-3.5" />
              {failure}
            </div>
          ) : null}
        </div>
        <div className="col-start-2 flex flex-wrap items-center gap-1 md:col-start-auto md:justify-end">
          <Button variant="ghost" size="xs" onClick={() => onView(candidate)}>
            <Search className="size-3.5" />
            View
          </Button>
          {shouldShowSleep ? (
            <Button variant="ghost" size="xs" onClick={() => onSleep(candidate)}>
              <Moon className="size-3.5" />
              Sleep
            </Button>
          ) : null}
          <Button variant="ghost" size="xs" onClick={() => onKeep(candidate)}>
            Hide
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="text-destructive hover:text-destructive"
            disabled={!selectable}
            onClick={() => onRemove(candidate)}
          >
            Remove
          </Button>
        </div>
      </div>
    </div>
  )
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
        Cleanup rechecks each selected workspace before deletion. Rows that are now dirty, active,
        running, disconnected, or have unverified commits are skipped.
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

async function sleepAndRefresh(worktreeId: string, refresh: () => void): Promise<void> {
  await runSleepWorktrees([worktreeId])
  refresh()
}
