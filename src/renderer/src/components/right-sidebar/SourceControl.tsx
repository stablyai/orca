/* eslint-disable max-lines */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  Minus,
  Plus,
  RefreshCw,
  Settings2,
  Undo2,
  FileEdit,
  FileMinus,
  FilePlus,
  FileQuestion,
  ArrowRightLeft,
  FolderOpen,
  GitMerge,
  GitPullRequestArrow,
  TriangleAlert,
  CircleCheck
} from 'lucide-react'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { basename, dirname, joinPath } from '@/lib/path'
import { cn } from '@/lib/utils'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { BulkActionBar } from './BulkActionBar'
import { useSourceControlSelection, type FlatEntry } from './useSourceControlSelection'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { BaseRefPicker } from '@/components/settings/BaseRefPicker'
import {
  notifyEditorExternalFileChange,
  requestEditorSaveQuiesce
} from '@/components/editor/editor-autosave'
import { PullRequestIcon } from './checks-helpers'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary,
  GitConflictKind,
  GitConflictOperation,
  GitStatusEntry,
  PRInfo
} from '../../../../shared/types'
import { STATUS_COLORS, STATUS_LABELS } from './status-display'

type SourceControlScope = 'all' | 'uncommitted'

const STATUS_ICONS: Record<
  string,
  React.ComponentType<{ className?: string; style?: React.CSSProperties }>
> = {
  modified: FileEdit,
  added: FilePlus,
  deleted: FileMinus,
  renamed: ArrowRightLeft,
  untracked: FileQuestion,
  copied: FilePlus
}

// Why: unstaged ("Changes") is listed first so that conflict files — which
// are assigned area:'unstaged' by the parser — appear above "Staged Changes".
// This keeps unresolved conflicts visible at the top of the list where the
// user won't miss them.
const SECTION_ORDER = ['unstaged', 'staged', 'untracked'] as const
const SECTION_LABELS: Record<(typeof SECTION_ORDER)[number], string> = {
  staged: 'Staged Changes',
  unstaged: 'Changes',
  untracked: 'Untracked Files'
}

const BRANCH_REFRESH_INTERVAL_MS = 5000

const CONFLICT_KIND_LABELS: Record<GitConflictKind, string> = {
  both_modified: 'Both modified',
  both_added: 'Both added',
  deleted_by_us: 'Deleted by us',
  deleted_by_them: 'Deleted by them',
  added_by_us: 'Added by us',
  added_by_them: 'Added by them',
  both_deleted: 'Both deleted'
}

export default function SourceControl(): React.JSX.Element {
  const sourceControlRef = useRef<HTMLDivElement>(null)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const gitConflictOperationByWorktree = useAppStore((s) => s.gitConflictOperationByWorktree)
  const gitBranchChangesByWorktree = useAppStore((s) => s.gitBranchChangesByWorktree)
  const gitBranchCompareSummaryByWorktree = useAppStore((s) => s.gitBranchCompareSummaryByWorktree)
  const prCache = useAppStore((s) => s.prCache)
  const fetchPRForBranch = useAppStore((s) => s.fetchPRForBranch)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const beginGitBranchCompareRequest = useAppStore((s) => s.beginGitBranchCompareRequest)
  const setGitBranchCompareResult = useAppStore((s) => s.setGitBranchCompareResult)
  const revealInExplorer = useAppStore((s) => s.revealInExplorer)
  const trackConflictPath = useAppStore((s) => s.trackConflictPath)
  const openDiff = useAppStore((s) => s.openDiff)
  const openConflictFile = useAppStore((s) => s.openConflictFile)
  const openConflictReview = useAppStore((s) => s.openConflictReview)
  const openBranchDiff = useAppStore((s) => s.openBranchDiff)
  const openAllDiffs = useAppStore((s) => s.openAllDiffs)
  const openBranchAllDiffs = useAppStore((s) => s.openBranchAllDiffs)

  const [scope, setScope] = useState<SourceControlScope>('all')
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set())
  const [baseRefDialogOpen, setBaseRefDialogOpen] = useState(false)
  const [defaultBaseRef, setDefaultBaseRef] = useState('origin/main')

  const activeWorktree = useMemo(() => {
    if (!activeWorktreeId) {
      return null
    }
    for (const worktrees of Object.values(worktreesByRepo)) {
      const worktree = worktrees.find((entry) => entry.id === activeWorktreeId)
      if (worktree) {
        return worktree
      }
    }
    return null
  }, [activeWorktreeId, worktreesByRepo])

  const activeRepo = useMemo(
    () => repos.find((repo) => repo.id === activeWorktree?.repoId) ?? null,
    [activeWorktree?.repoId, repos]
  )
  const isFolder = activeRepo ? isFolderRepo(activeRepo) : false
  const worktreePath = activeWorktree?.path ?? null
  const entries = useMemo(
    () => (activeWorktreeId ? (gitStatusByWorktree[activeWorktreeId] ?? []) : []),
    [activeWorktreeId, gitStatusByWorktree]
  )
  const branchEntries = useMemo(
    () => (activeWorktreeId ? (gitBranchChangesByWorktree[activeWorktreeId] ?? []) : []),
    [activeWorktreeId, gitBranchChangesByWorktree]
  )
  const branchSummary = activeWorktreeId
    ? (gitBranchCompareSummaryByWorktree[activeWorktreeId] ?? null)
    : null
  const conflictOperation = activeWorktreeId
    ? (gitConflictOperationByWorktree[activeWorktreeId] ?? 'unknown')
    : 'unknown'
  const isBranchVisible = rightSidebarTab === 'source-control'

  useEffect(() => {
    if (!activeRepo || isFolder) {
      return
    }

    let stale = false
    void window.api.repos
      .getBaseRefDefault({ repoId: activeRepo.id })
      .then((result) => {
        if (!stale) {
          setDefaultBaseRef(result)
        }
      })
      .catch(() => {
        if (!stale) {
          setDefaultBaseRef('origin/main')
        }
      })

    return () => {
      stale = true
    }
  }, [activeRepo, isFolder])

  const effectiveBaseRef = activeRepo?.worktreeBaseRef ?? defaultBaseRef
  const hasUncommittedEntries = entries.length > 0
  const branchCompareAvailable = branchSummary?.status === 'ready'
  const hasBranchEntries = branchCompareAvailable && branchEntries.length > 0
  const branchName = activeWorktree?.branch.replace(/^refs\/heads\//, '') ?? 'HEAD'
  const prCacheKey = activeRepo && branchName ? `${activeRepo.path}::${branchName}` : null
  const prInfo: PRInfo | null = prCacheKey ? (prCache[prCacheKey]?.data ?? null) : null

  useEffect(() => {
    if (!isBranchVisible || !activeRepo || isFolder || !branchName || branchName === 'HEAD') {
      return
    }

    // Why: the Source Control panel renders the branch's PR badge directly.
    // When a terminal checkout moves this worktree onto a new branch, we need
    // to fetch that branch's PR immediately instead of waiting for the user to
    // reselect the worktree or open the separate Checks panel.
    void fetchPRForBranch(activeRepo.path, branchName)
  }, [activeRepo, branchName, fetchPRForBranch, isBranchVisible, isFolder])

  const grouped = useMemo(() => {
    const groups = {
      staged: [] as GitStatusEntry[],
      unstaged: [] as GitStatusEntry[],
      untracked: [] as GitStatusEntry[]
    }
    for (const entry of entries) {
      groups[entry.area].push(entry)
    }
    for (const area of SECTION_ORDER) {
      groups[area].sort(compareGitStatusEntries)
    }
    return groups
  }, [entries])

  const flatEntries = useMemo(() => {
    const arr: FlatEntry[] = []
    for (const area of SECTION_ORDER) {
      if (!collapsedSections.has(area)) {
        for (const entry of grouped[area]) {
          arr.push({ key: `${area}::${entry.path}`, entry, area })
        }
      }
    }
    return arr
  }, [grouped, collapsedSections])

  const [isExecutingBulk, setIsExecutingBulk] = useState(false)

  const handleOpenDiff = useCallback(
    (entry: GitStatusEntry) => {
      if (!activeWorktreeId || !worktreePath) {
        return
      }
      if (entry.conflictKind && entry.conflictStatus) {
        if (entry.conflictStatus === 'unresolved') {
          trackConflictPath(activeWorktreeId, entry.path, entry.conflictKind)
        }
        openConflictFile(activeWorktreeId, worktreePath, entry, detectLanguage(entry.path))
        return
      }
      openDiff(
        activeWorktreeId,
        joinPath(worktreePath, entry.path),
        entry.path,
        detectLanguage(entry.path),
        entry.area === 'staged'
      )
    },
    [activeWorktreeId, worktreePath, trackConflictPath, openConflictFile, openDiff]
  )

  const { selectedKeys, handleSelect, handleContextMenu, clearSelection } =
    useSourceControlSelection({
      flatEntries,
      onOpenDiff: handleOpenDiff,
      containerRef: sourceControlRef
    })

  // clear selection on scope change
  useEffect(() => {
    clearSelection()
  }, [scope, clearSelection])

  // Clear selection on worktree or tab change
  useEffect(() => {
    clearSelection()
  }, [activeWorktreeId, rightSidebarTab, clearSelection])

  const flatEntriesByKey = useMemo(
    () => new Map(flatEntries.map((entry) => [entry.key, entry])),
    [flatEntries]
  )

  const selectedEntries = useMemo(
    () =>
      Array.from(selectedKeys)
        .map((key) => flatEntriesByKey.get(key))
        .filter((entry): entry is FlatEntry => Boolean(entry)),
    [selectedKeys, flatEntriesByKey]
  )

  const bulkStagePaths = useMemo(
    () =>
      selectedEntries
        .filter(
          (entry) =>
            (entry.area === 'unstaged' || entry.area === 'untracked') &&
            entry.entry.conflictStatus !== 'unresolved'
        )
        .map((entry) => entry.entry.path),
    [selectedEntries]
  )

  const bulkUnstagePaths = useMemo(
    () =>
      selectedEntries.filter((entry) => entry.area === 'staged').map((entry) => entry.entry.path),
    [selectedEntries]
  )

  const selectedKeySet = selectedKeys

  const handleBulkStage = useCallback(async () => {
    if (!worktreePath || bulkStagePaths.length === 0) {
      return
    }
    setIsExecutingBulk(true)
    try {
      await window.api.git.bulkStage({ worktreePath, filePaths: bulkStagePaths })
      clearSelection()
    } finally {
      setIsExecutingBulk(false)
    }
  }, [worktreePath, bulkStagePaths, clearSelection])

  const handleBulkUnstage = useCallback(async () => {
    if (!worktreePath || bulkUnstagePaths.length === 0) {
      return
    }
    setIsExecutingBulk(true)
    try {
      await window.api.git.bulkUnstage({ worktreePath, filePaths: bulkUnstagePaths })
      clearSelection()
    } finally {
      setIsExecutingBulk(false)
    }
  }, [worktreePath, bulkUnstagePaths, clearSelection])

  const unresolvedConflicts = useMemo(
    () => entries.filter((entry) => entry.conflictStatus === 'unresolved' && entry.conflictKind),
    [entries]
  )
  const unresolvedConflictReviewEntries = useMemo(
    () =>
      unresolvedConflicts.map((entry) => ({
        path: entry.path,
        conflictKind: entry.conflictKind!
      })),
    [unresolvedConflicts]
  )

  const refreshBranchCompare = useCallback(async () => {
    if (!activeWorktreeId || !worktreePath || !effectiveBaseRef || isFolder) {
      return
    }

    const requestKey = `${activeWorktreeId}:${effectiveBaseRef}:${Date.now()}`
    const existingSummary =
      useAppStore.getState().gitBranchCompareSummaryByWorktree[activeWorktreeId]
    const isBackgroundRefresh = existingSummary && existingSummary.status === 'ready'
    if (isBackgroundRefresh) {
      // Update the request key without resetting to loading state
      useAppStore.setState((s) => ({
        gitBranchCompareRequestKeyByWorktree: {
          ...s.gitBranchCompareRequestKeyByWorktree,
          [activeWorktreeId]: requestKey
        }
      }))
    } else {
      beginGitBranchCompareRequest(activeWorktreeId, requestKey, effectiveBaseRef)
    }

    try {
      const result = await window.api.git.branchCompare({
        worktreePath,
        baseRef: effectiveBaseRef
      })
      setGitBranchCompareResult(activeWorktreeId, requestKey, result)
    } catch (error) {
      setGitBranchCompareResult(activeWorktreeId, requestKey, {
        summary: {
          baseRef: effectiveBaseRef,
          baseOid: null,
          compareRef: branchName,
          headOid: null,
          mergeBase: null,
          changedFiles: 0,
          status: 'error',
          errorMessage: error instanceof Error ? error.message : 'Branch compare failed'
        },
        entries: []
      })
    }
  }, [
    activeWorktreeId,
    beginGitBranchCompareRequest,
    branchName,
    effectiveBaseRef,
    isFolder,
    setGitBranchCompareResult,
    worktreePath
  ])

  const refreshBranchCompareRef = useRef(refreshBranchCompare)
  refreshBranchCompareRef.current = refreshBranchCompare

  useEffect(() => {
    if (!activeWorktreeId || !worktreePath || !isBranchVisible || !effectiveBaseRef || isFolder) {
      return
    }

    void refreshBranchCompareRef.current()
    const intervalId = window.setInterval(
      () => void refreshBranchCompareRef.current(),
      BRANCH_REFRESH_INTERVAL_MS
    )
    return () => window.clearInterval(intervalId)
  }, [activeWorktreeId, effectiveBaseRef, isBranchVisible, isFolder, worktreePath])

  const toggleSection = useCallback((section: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(section)) {
        next.delete(section)
      } else {
        next.add(section)
      }
      return next
    })
  }, [])

  const openCommittedDiff = useCallback(
    (entry: GitBranchChangeEntry) => {
      if (
        !activeWorktreeId ||
        !worktreePath ||
        !branchSummary ||
        branchSummary.status !== 'ready'
      ) {
        return
      }
      openBranchDiff(
        activeWorktreeId,
        worktreePath,
        entry,
        branchSummary,
        detectLanguage(entry.path)
      )
    },
    [activeWorktreeId, branchSummary, openBranchDiff, worktreePath]
  )

  const handleStage = useCallback(
    async (filePath: string) => {
      if (!worktreePath) {
        return
      }
      try {
        await window.api.git.stage({ worktreePath, filePath })
      } catch {
        // git operation failed silently
      }
    },
    [worktreePath]
  )

  const handleUnstage = useCallback(
    async (filePath: string) => {
      if (!worktreePath) {
        return
      }
      try {
        await window.api.git.unstage({ worktreePath, filePath })
      } catch {
        // git operation failed silently
      }
    },
    [worktreePath]
  )

  const handleDiscard = useCallback(
    async (filePath: string) => {
      if (!worktreePath || !activeWorktreeId) {
        return
      }
      try {
        // Why: git discard replaces the working tree version of this file. Any
        // pending editor autosave must be quiesced first so it cannot recreate
        // the discarded edits after git restores the file.
        await requestEditorSaveQuiesce({
          worktreeId: activeWorktreeId,
          worktreePath,
          relativePath: filePath
        })
        await window.api.git.discard({ worktreePath, filePath })
        notifyEditorExternalFileChange({
          worktreeId: activeWorktreeId,
          worktreePath,
          relativePath: filePath
        })
      } catch {
        // git operation failed silently
      }
    },
    [activeWorktreeId, worktreePath]
  )

  if (!activeWorktree || !activeRepo || !worktreePath) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground px-4 text-center">
        Select a worktree to view changes
      </div>
    )
  }
  if (isFolder) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground px-4 text-center">
        Source Control is only available for Git repositories
      </div>
    )
  }

  const showGenericEmptyState =
    !hasUncommittedEntries && branchSummary?.status === 'ready' && branchEntries.length === 0
  const currentWorktreeId = activeWorktree.id

  return (
    <>
      <div ref={sourceControlRef} className="relative flex h-full flex-col overflow-hidden">
        <div className="flex items-center px-3 pt-2 border-b border-border">
          {(['all', 'uncommitted'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={cn(
                'px-3 pb-2 text-xs font-medium transition-colors border-b-2 -mb-px',
                scope === value
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setScope(value)}
            >
              {value === 'all' ? 'All' : 'Uncommitted'}
            </button>
          ))}
          {prInfo && (
            <div className="ml-auto mb-1.5 flex items-center gap-1.5 min-w-0 text-[11.5px] leading-none">
              <PullRequestIcon
                className={cn(
                  'size-3 shrink-0',
                  prInfo.state === 'merged' && 'text-purple-500/80',
                  prInfo.state === 'open' && 'text-emerald-500/80',
                  prInfo.state === 'closed' && 'text-muted-foreground/60',
                  prInfo.state === 'draft' && 'text-muted-foreground/50'
                )}
              />
              <a
                href={prInfo.url}
                target="_blank"
                rel="noreferrer"
                className="text-foreground opacity-80 font-medium shrink-0 hover:text-foreground hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                PR #{prInfo.number}
              </a>
            </div>
          )}
        </div>

        {scope === 'all' && (
          <div className="border-b border-border px-3 py-2">
            <CompareSummary
              summary={branchSummary}
              onChangeBaseRef={() => setBaseRefDialogOpen(true)}
              onRetry={() => void refreshBranchCompare()}
            />
          </div>
        )}

        <div
          className="relative flex-1 overflow-auto scrollbar-sleek py-1"
          style={{ paddingBottom: selectedKeys.size > 0 ? 50 : undefined }}
        >
          {unresolvedConflictReviewEntries.length > 0 && (
            <div className="px-3 pb-2">
              <ConflictSummaryCard
                conflictOperation={conflictOperation}
                unresolvedCount={unresolvedConflictReviewEntries.length}
                onReview={() => {
                  if (!activeWorktreeId || !worktreePath) {
                    return
                  }
                  openConflictReview(
                    activeWorktreeId,
                    worktreePath,
                    unresolvedConflictReviewEntries,
                    'live-summary'
                  )
                }}
              />
            </div>
          )}
          {/* Why: show operation banner when rebase/merge/cherry-pick is in progress
              but there are no unresolved conflicts (e.g. between rebase steps, or
              after resolving all conflicts before running --continue). The
              ConflictSummaryCard handles the "has conflicts" case above. */}
          {unresolvedConflictReviewEntries.length === 0 && conflictOperation !== 'unknown' && (
            <div className="px-3 pb-2">
              <OperationBanner conflictOperation={conflictOperation} />
            </div>
          )}

          {scope === 'all' && showGenericEmptyState ? (
            <EmptyState
              heading="No changes on this branch"
              supportingText={`This worktree is clean and this branch has no changes ahead of ${branchSummary.baseRef}`}
            />
          ) : null}

          {scope === 'uncommitted' && !hasUncommittedEntries && (
            <EmptyState
              heading="No uncommitted changes"
              supportingText="All changes have been committed"
            />
          )}

          {(scope === 'all' || scope === 'uncommitted') && hasUncommittedEntries && (
            <>
              {SECTION_ORDER.map((area) => {
                const items = grouped[area]
                if (items.length === 0) {
                  return null
                }
                const isCollapsed = collapsedSections.has(area)
                return (
                  <div key={area}>
                    <SectionHeader
                      label={SECTION_LABELS[area]}
                      count={items.length}
                      conflictCount={
                        items.filter((entry) => entry.conflictStatus === 'unresolved').length
                      }
                      isCollapsed={isCollapsed}
                      onToggle={() => toggleSection(area)}
                      actions={
                        items.some((entry) => entry.conflictStatus === 'unresolved') ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (activeWorktreeId && worktreePath) {
                                openAllDiffs(activeWorktreeId, worktreePath, undefined, area)
                              }
                            }}
                          >
                            View all
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-auto px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (activeWorktreeId && worktreePath) {
                                openAllDiffs(activeWorktreeId, worktreePath, undefined, area)
                              }
                            }}
                          >
                            View all
                          </Button>
                        )
                      }
                    />
                    {!isCollapsed &&
                      items.map((entry) => {
                        const key = `${entry.area}::${entry.path}`
                        return (
                          <UncommittedEntryRow
                            key={key}
                            entryKey={key}
                            entry={entry}
                            currentWorktreeId={currentWorktreeId}
                            worktreePath={worktreePath}
                            selected={selectedKeySet.has(key)}
                            onSelect={handleSelect}
                            onContextMenu={handleContextMenu}
                            onRevealInExplorer={revealInExplorer}
                            onOpen={handleOpenDiff}
                            onStage={handleStage}
                            onUnstage={handleUnstage}
                            onDiscard={handleDiscard}
                          />
                        )
                      })}
                  </div>
                )
              })}
            </>
          )}

          {scope === 'all' &&
          branchSummary &&
          branchSummary.status !== 'ready' &&
          branchSummary.status !== 'loading' ? (
            <CompareUnavailable
              summary={branchSummary}
              onChangeBaseRef={() => setBaseRefDialogOpen(true)}
              onRetry={() => void refreshBranchCompare()}
            />
          ) : null}

          {scope === 'all' && branchSummary?.status === 'ready' && hasBranchEntries && (
            <div>
              <SectionHeader
                label="Committed on Branch"
                count={branchEntries.length}
                isCollapsed={collapsedSections.has('branch')}
                onToggle={() => toggleSection('branch')}
                actions={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (activeWorktreeId && worktreePath && branchSummary) {
                        openBranchAllDiffs(activeWorktreeId, worktreePath, branchSummary)
                      }
                    }}
                  >
                    View all
                  </Button>
                }
              />
              {!collapsedSections.has('branch') &&
                branchEntries.map((entry) => (
                  <BranchEntryRow
                    key={`branch:${entry.path}`}
                    entry={entry}
                    currentWorktreeId={currentWorktreeId}
                    worktreePath={worktreePath}
                    onRevealInExplorer={revealInExplorer}
                    onOpen={() => openCommittedDiff(entry)}
                  />
                ))}
            </div>
          )}
        </div>

        {selectedKeys.size > 0 && (
          <BulkActionBar
            selectedCount={selectedKeys.size}
            stageableCount={bulkStagePaths.length}
            unstageableCount={bulkUnstagePaths.length}
            onStage={handleBulkStage}
            onUnstage={handleBulkUnstage}
            onClear={clearSelection}
            isExecuting={isExecutingBulk}
          />
        )}
      </div>

      <Dialog open={baseRefDialogOpen} onOpenChange={setBaseRefDialogOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-sm">Change Base Ref</DialogTitle>
            <DialogDescription className="text-xs">
              Pick the branch compare target for this repository.
            </DialogDescription>
          </DialogHeader>
          <BaseRefPicker
            repoId={activeRepo.id}
            currentBaseRef={activeRepo.worktreeBaseRef}
            onSelect={(ref) => {
              void updateRepo(activeRepo.id, { worktreeBaseRef: ref })
              setBaseRefDialogOpen(false)
              window.setTimeout(() => void refreshBranchCompare(), 0)
            }}
            onUsePrimary={() => {
              void updateRepo(activeRepo.id, { worktreeBaseRef: undefined })
              setBaseRefDialogOpen(false)
              window.setTimeout(() => void refreshBranchCompare(), 0)
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}

function CompareSummary({
  summary,
  onChangeBaseRef,
  onRetry
}: {
  summary: GitBranchCompareSummary | null
  onChangeBaseRef: () => void
  onRetry: () => void
}): React.JSX.Element {
  if (!summary || summary.status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <RefreshCw className="size-3.5 animate-spin" />
        <span>Comparing against {summary?.baseRef ?? '…'}</span>
      </div>
    )
  }

  if (summary.status !== 'ready') {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate">{summary.errorMessage ?? 'Branch compare unavailable'}</span>
        <button
          className="shrink-0 hover:text-foreground"
          onClick={onChangeBaseRef}
          title="Change base ref"
        >
          <Settings2 className="size-3.5" />
        </button>
        <button className="shrink-0 hover:text-foreground" onClick={onRetry} title="Retry">
          <RefreshCw className="size-3.5" />
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      {summary.commitsAhead !== undefined && (
        <span title={`Comparing against ${summary.baseRef}`}>
          {summary.commitsAhead} commits ahead
        </span>
      )}
      <TooltipProvider delayDuration={400}>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="hover:text-foreground p-0.5 rounded" onClick={onChangeBaseRef}>
                <Settings2 className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Change base ref
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="hover:text-foreground p-0.5 rounded" onClick={onRetry}>
                <RefreshCw className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              Refresh branch compare
            </TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </div>
  )
}

function CompareUnavailable({
  summary,
  onChangeBaseRef,
  onRetry
}: {
  summary: GitBranchCompareSummary
  onChangeBaseRef: () => void
  onRetry: () => void
}): React.JSX.Element {
  const changeBaseRefAllowed =
    summary.status === 'invalid-base' ||
    summary.status === 'no-merge-base' ||
    summary.status === 'error'

  return (
    <div className="m-3 rounded-md border border-border/60 bg-muted/20 px-3 py-3 text-xs">
      <div className="font-medium text-foreground">
        {summary.status === 'error' ? 'Branch compare failed' : 'Branch compare unavailable'}
      </div>
      <div className="mt-1 text-muted-foreground">
        {summary.errorMessage ?? 'Unable to load branch compare.'}
      </div>
      <div className="mt-3 flex items-center gap-2">
        {changeBaseRefAllowed && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={onChangeBaseRef}
          >
            <Settings2 className="size-3.5" />
            Change Base Ref
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={onRetry}>
          <RefreshCw className="size-3.5" />
          Retry
        </Button>
      </div>
    </div>
  )
}

function SectionHeader({
  label,
  count,
  conflictCount = 0,
  isCollapsed,
  onToggle,
  actions
}: {
  label: string
  count: number
  conflictCount?: number
  isCollapsed: boolean
  onToggle: () => void
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="group/section flex items-center pl-1 pr-3 pt-3 pb-1">
      <button
        type="button"
        className="flex flex-1 items-center gap-1 rounded-md px-0.5 py-0.5 text-left text-xs font-semibold uppercase tracking-wider text-foreground/70 hover:bg-accent hover:text-accent-foreground"
        onClick={onToggle}
      >
        <ChevronDown
          className={cn('size-3.5 shrink-0 transition-transform', isCollapsed && '-rotate-90')}
        />
        <span>{label}</span>
        <span className="text-[11px] font-medium tabular-nums">{count}</span>
        {conflictCount > 0 && (
          <span className="text-[11px] font-medium text-destructive/80">
            · {conflictCount} conflict{conflictCount === 1 ? '' : 's'}
          </span>
        )}
      </button>
      <div className="shrink-0 flex items-center">{actions}</div>
    </div>
  )
}

function ConflictSummaryCard({
  conflictOperation,
  unresolvedCount,
  onReview
}: {
  conflictOperation: GitConflictOperation
  unresolvedCount: number
  onReview: () => void
}): React.JSX.Element {
  const operationLabel =
    conflictOperation === 'merge'
      ? 'Merge conflicts'
      : conflictOperation === 'rebase'
        ? 'Rebase conflicts'
        : conflictOperation === 'cherry-pick'
          ? 'Cherry-pick conflicts'
          : 'Conflicts'

  return (
    <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <div
            className="text-xs font-medium text-foreground"
            aria-live="polite"
          >{`${operationLabel}: ${unresolvedCount} unresolved`}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Resolved files move back to normal changes after they leave the live conflict state.
          </div>
        </div>
      </div>
      <div className="mt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs w-full"
          onClick={onReview}
        >
          <GitMerge className="size-3.5" />
          Review conflicts
        </Button>
      </div>
    </div>
  )
}

// Why: this banner is separate from ConflictSummaryCard because a rebase (or
// merge/cherry-pick) can be in progress without any conflicts — e.g. between
// rebase steps, or after resolving all conflicts but before --continue. The
// user needs to see the operation state so they know the worktree is mid-rebase
// and that they should run `git rebase --continue` or `--abort`.
function OperationBanner({
  conflictOperation
}: {
  conflictOperation: GitConflictOperation
}): React.JSX.Element {
  const label =
    conflictOperation === 'merge'
      ? 'Merge in progress'
      : conflictOperation === 'rebase'
        ? 'Rebase in progress'
        : conflictOperation === 'cherry-pick'
          ? 'Cherry-pick in progress'
          : 'Operation in progress'

  const Icon = conflictOperation === 'rebase' ? GitPullRequestArrow : GitMerge

  return (
    <div className="rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="text-xs font-medium text-foreground">{label}</span>
      </div>
    </div>
  )
}

const UncommittedEntryRow = React.memo(function UncommittedEntryRow({
  entryKey,
  entry,
  currentWorktreeId,
  worktreePath,
  selected,
  onSelect,
  onContextMenu,
  onRevealInExplorer,
  onOpen,
  onStage,
  onUnstage,
  onDiscard
}: {
  entryKey: string
  entry: GitStatusEntry
  currentWorktreeId: string
  worktreePath: string
  selected?: boolean
  onSelect?: (e: React.MouseEvent, key: string, entry: GitStatusEntry) => void
  onContextMenu?: (key: string) => void
  onRevealInExplorer: (worktreeId: string, absolutePath: string) => void
  onOpen: (entry: GitStatusEntry) => void
  onStage: (filePath: string) => Promise<void>
  onUnstage: (filePath: string) => Promise<void>
  onDiscard: (filePath: string) => Promise<void>
}): React.JSX.Element {
  const StatusIcon = STATUS_ICONS[entry.status] ?? FileQuestion
  const fileName = basename(entry.path)
  const parentDir = dirname(entry.path)
  const dirPath = parentDir === '.' ? '' : parentDir
  const isUnresolvedConflict = entry.conflictStatus === 'unresolved'
  const isResolvedLocally = entry.conflictStatus === 'resolved_locally'
  const conflictLabel = entry.conflictKind ? CONFLICT_KIND_LABELS[entry.conflictKind] : null
  // Why: the hint text ("Open and edit…", "Decide whether to…") was removed
  // from the sidebar because it's not actionable here — the user can only
  // click the row, and the conflict-kind label alone is sufficient context.
  // Why: Stage is suppressed for unresolved conflicts because `git add` would
  // immediately erase the `u` record — the only live conflict signal in the
  // sidebar — before the user has actually reviewed the file. The user should
  // resolve in the editor first, then stage from the post-resolution state.
  //
  // Discard is hidden for both unresolved AND resolved_locally rows in v1.
  // For unresolved: discarding is too easy to misfire on a high-risk file.
  // For resolved_locally: discarding can silently re-create the conflict or
  // lose the resolution, and v1 does not have UX to explain this clearly.
  const canDiscard =
    !isUnresolvedConflict &&
    !isResolvedLocally &&
    (entry.area === 'unstaged' || entry.area === 'untracked')
  const canStage =
    !isUnresolvedConflict && (entry.area === 'unstaged' || entry.area === 'untracked')
  const canUnstage = entry.area === 'staged'

  return (
    <SourceControlEntryContextMenu
      currentWorktreeId={currentWorktreeId}
      absolutePath={joinPath(worktreePath, entry.path)}
      onRevealInExplorer={onRevealInExplorer}
      onOpenChange={(open) => {
        if (open && onContextMenu) {
          onContextMenu(entryKey)
        }
      }}
    >
      <div
        className={cn(
          'group relative flex cursor-pointer items-center gap-1 pl-5 pr-3 py-1 transition-colors hover:bg-accent/40',
          selected && 'bg-accent/60'
        )}
        draggable
        onDragStart={(e) => {
          if (isUnresolvedConflict && entry.status === 'deleted') {
            e.preventDefault()
            return
          }
          const absolutePath = joinPath(worktreePath, entry.path)
          e.dataTransfer.setData('text/x-orca-file-path', absolutePath)
          e.dataTransfer.effectAllowed = 'copy'
        }}
        onClick={(e) => {
          if (onSelect) {
            onSelect(e, entryKey, entry)
          } else {
            onOpen(entry)
          }
        }}
      >
        <StatusIcon className="size-3.5 shrink-0" style={{ color: STATUS_COLORS[entry.status] }} />
        <div className="min-w-0 flex-1 text-xs">
          <span className="min-w-0 block truncate">
            <span className="text-foreground">{fileName}</span>
            {dirPath && <span className="ml-1.5 text-[11px] text-muted-foreground">{dirPath}</span>}
          </span>
          {conflictLabel && (
            <div className="truncate text-[11px] text-muted-foreground">{conflictLabel}</div>
          )}
        </div>
        {entry.conflictStatus ? (
          <ConflictBadge entry={entry} />
        ) : (
          <span
            className="w-4 shrink-0 text-center text-[10px] font-bold"
            style={{ color: STATUS_COLORS[entry.status] }}
          >
            {STATUS_LABELS[entry.status]}
          </span>
        )}
        <div className="absolute right-0 top-0 bottom-0 shrink-0 hidden group-hover:flex items-center gap-1.5 bg-accent pr-3 pl-2">
          {canDiscard && (
            <ActionButton
              icon={Undo2}
              title={entry.area === 'untracked' ? 'Revert untracked file' : 'Discard changes'}
              onClick={(event) => {
                event.stopPropagation()
                void onDiscard(entry.path)
              }}
            />
          )}
          {canStage && (
            <ActionButton
              icon={Plus}
              title="Stage"
              onClick={(event) => {
                event.stopPropagation()
                void onStage(entry.path)
              }}
            />
          )}
          {canUnstage && (
            <ActionButton
              icon={Minus}
              title="Unstage"
              onClick={(event) => {
                event.stopPropagation()
                void onUnstage(entry.path)
              }}
            />
          )}
        </div>
      </div>
    </SourceControlEntryContextMenu>
  )
})

function ConflictBadge({ entry }: { entry: GitStatusEntry }): React.JSX.Element {
  const isUnresolvedConflict = entry.conflictStatus === 'unresolved'
  const label = isUnresolvedConflict ? 'Unresolved' : 'Resolved locally'
  const Icon = isUnresolvedConflict ? TriangleAlert : CircleCheck
  const badge = (
    <span
      role="status"
      aria-label={`${label} conflict${entry.conflictKind ? `, ${CONFLICT_KIND_LABELS[entry.conflictKind]}` : ''}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
        isUnresolvedConflict
          ? 'bg-destructive/12 text-destructive'
          : 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400'
      )}
    >
      <Icon className="size-3" />
      <span>{label}</span>
    </span>
  )

  if (isUnresolvedConflict) {
    return badge
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{badge}</TooltipTrigger>
        <TooltipContent side="left" sideOffset={6}>
          Local session state derived from a conflict you opened here.
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function BranchEntryRow({
  entry,
  currentWorktreeId,
  worktreePath,
  onRevealInExplorer,
  onOpen
}: {
  entry: GitBranchChangeEntry
  currentWorktreeId: string
  worktreePath: string
  onRevealInExplorer: (worktreeId: string, absolutePath: string) => void
  onOpen: () => void
}): React.JSX.Element {
  const StatusIcon = STATUS_ICONS[entry.status] ?? FileQuestion
  const fileName = basename(entry.path)
  const parentDir = dirname(entry.path)
  const dirPath = parentDir === '.' ? '' : parentDir

  return (
    <SourceControlEntryContextMenu
      currentWorktreeId={currentWorktreeId}
      absolutePath={joinPath(worktreePath, entry.path)}
      onRevealInExplorer={onRevealInExplorer}
    >
      <div
        className="group flex cursor-pointer items-center gap-1 pl-5 pr-3 py-1 transition-colors hover:bg-accent/40"
        onClick={onOpen}
      >
        <StatusIcon className="size-3.5 shrink-0" style={{ color: STATUS_COLORS[entry.status] }} />
        <span className="min-w-0 flex-1 truncate text-xs">
          <span className="text-foreground">{fileName}</span>
          {dirPath && <span className="ml-1.5 text-[11px] text-muted-foreground">{dirPath}</span>}
        </span>
        <span
          className="w-4 shrink-0 text-center text-[10px] font-bold"
          style={{ color: STATUS_COLORS[entry.status] }}
        >
          {STATUS_LABELS[entry.status]}
        </span>
      </div>
    </SourceControlEntryContextMenu>
  )
}

function SourceControlEntryContextMenu({
  currentWorktreeId,
  absolutePath,
  onRevealInExplorer,
  onOpenChange,
  children
}: {
  currentWorktreeId: string
  absolutePath?: string
  onRevealInExplorer: (worktreeId: string, absolutePath: string) => void
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}): React.JSX.Element {
  const handleOpenInFileExplorer = useCallback(() => {
    if (!absolutePath) {
      return
    }
    onRevealInExplorer(currentWorktreeId, absolutePath)
  }, [absolutePath, currentWorktreeId, onRevealInExplorer])

  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={handleOpenInFileExplorer} disabled={!absolutePath}>
          <FolderOpen className="size-3.5" />
          Open in File Explorer
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function EmptyState({
  heading,
  supportingText
}: {
  heading: string
  supportingText: string
}): React.JSX.Element {
  return (
    <div className="px-4 py-6">
      <div className="text-sm font-medium text-foreground">{heading}</div>
      <div className="mt-1 text-xs text-muted-foreground">{supportingText}</div>
    </div>
  )
}

function ActionButton({
  icon: Icon,
  title,
  onClick
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  onClick: (event: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="h-auto w-auto p-0.5 text-muted-foreground hover:text-foreground"
      title={title}
      onClick={onClick}
    >
      <Icon className="size-3.5" />
    </Button>
  )
}

function compareGitStatusEntries(a: GitStatusEntry, b: GitStatusEntry): number {
  return (
    getConflictSortRank(a) - getConflictSortRank(b) ||
    a.path.localeCompare(b.path, undefined, { numeric: true })
  )
}

function getConflictSortRank(entry: GitStatusEntry): number {
  if (entry.conflictStatus === 'unresolved') {
    return 0
  }
  if (entry.conflictStatus === 'resolved_locally') {
    return 1
  }
  return 2
}
