/* eslint-disable max-lines */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  Layers,
  Minus,
  Plus,
  RefreshCw,
  Settings2,
  Undo2,
  FileEdit,
  FileMinus,
  FilePlus,
  FileQuestion,
  ArrowRightLeft
} from 'lucide-react'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { basename, dirname, joinPath } from '@/lib/path'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { BaseRefPicker } from '@/components/settings/BaseRefPicker'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary,
  GitStatusEntry,
  PRInfo
} from '../../../../shared/types'
import { getSourceControlActions } from './source-control-actions'
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

const SECTION_ORDER = ['staged', 'unstaged', 'untracked'] as const
const SECTION_LABELS: Record<(typeof SECTION_ORDER)[number], string> = {
  staged: 'Staged Changes',
  unstaged: 'Changes',
  untracked: 'Untracked Files'
}

const BRANCH_REFRESH_INTERVAL_MS = 5000

export default function SourceControl(): React.JSX.Element {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const rightSidebarTab = useAppStore((s) => s.rightSidebarTab)
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const gitStatusByWorktree = useAppStore((s) => s.gitStatusByWorktree)
  const gitBranchChangesByWorktree = useAppStore((s) => s.gitBranchChangesByWorktree)
  const gitBranchCompareSummaryByWorktree = useAppStore((s) => s.gitBranchCompareSummaryByWorktree)
  const prCache = useAppStore((s) => s.prCache)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const beginGitBranchCompareRequest = useAppStore((s) => s.beginGitBranchCompareRequest)
  const setGitBranchCompareResult = useAppStore((s) => s.setGitBranchCompareResult)
  const openDiff = useAppStore((s) => s.openDiff)
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
  const isBranchVisible = rightSidebarTab === 'source-control'

  useEffect(() => {
    if (!activeRepo) {
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
  }, [activeRepo])

  const effectiveBaseRef = activeRepo?.worktreeBaseRef ?? defaultBaseRef
  const hasUncommittedEntries = entries.length > 0
  const branchCompareAvailable = branchSummary?.status === 'ready'
  const hasBranchEntries = branchCompareAvailable && branchEntries.length > 0
  const branchName = activeWorktree?.branch.replace(/^refs\/heads\//, '') ?? 'HEAD'
  const prCacheKey = activeRepo ? `${activeRepo.path}::${branchName}` : null
  const prInfo: PRInfo | null = prCacheKey ? (prCache[prCacheKey]?.data ?? null) : null

  const grouped = useMemo(() => {
    const groups = {
      staged: [] as GitStatusEntry[],
      unstaged: [] as GitStatusEntry[],
      untracked: [] as GitStatusEntry[]
    }
    for (const entry of entries) {
      groups[entry.area].push(entry)
    }
    return groups
  }, [entries])

  const refreshBranchCompare = useCallback(async () => {
    if (!activeWorktreeId || !worktreePath || !effectiveBaseRef) {
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
    setGitBranchCompareResult,
    worktreePath
  ])

  const refreshBranchCompareRef = useRef(refreshBranchCompare)
  refreshBranchCompareRef.current = refreshBranchCompare

  useEffect(() => {
    if (!activeWorktreeId || !worktreePath || !isBranchVisible || !effectiveBaseRef) {
      return
    }

    void refreshBranchCompareRef.current()
    const intervalId = window.setInterval(
      () => void refreshBranchCompareRef.current(),
      BRANCH_REFRESH_INTERVAL_MS
    )
    return () => window.clearInterval(intervalId)
  }, [activeWorktreeId, effectiveBaseRef, isBranchVisible, worktreePath])

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

  const openUncommittedDiff = useCallback(
    (entry: GitStatusEntry) => {
      if (!activeWorktreeId || !worktreePath) {
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
    [activeWorktreeId, openDiff, worktreePath]
  )

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
      if (!worktreePath) {
        return
      }
      try {
        await window.api.git.discard({ worktreePath, filePath })
      } catch {
        // git operation failed silently
      }
    },
    [worktreePath]
  )

  if (!activeWorktree || !activeRepo || !worktreePath) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-muted-foreground px-4 text-center">
        Select a worktree to view changes
      </div>
    )
  }

  const showGenericEmptyState =
    !hasUncommittedEntries && branchSummary?.status === 'ready' && branchEntries.length === 0

  return (
    <>
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex px-3 pt-2 border-b border-border">
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
        </div>

        {scope === 'all' && (
          <div className="border-b border-border px-3 py-2">
            <CompareSummary
              summary={branchSummary}
              uncommittedCount={entries.length}
              prInfo={prInfo}
              onChangeBaseRef={() => setBaseRefDialogOpen(true)}
              onRetry={() => void refreshBranchCompare()}
            />
          </div>
        )}

        <div className="flex-1 overflow-auto scrollbar-sleek py-1">
          {showGenericEmptyState ? (
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
                      isCollapsed={isCollapsed}
                      onToggle={() => toggleSection(area)}
                      actions={
                        <ActionButton
                          icon={Layers}
                          title="Open all diffs in this section"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (activeWorktreeId && worktreePath) {
                              openAllDiffs(activeWorktreeId, worktreePath, undefined, area)
                            }
                          }}
                        />
                      }
                    />
                    {!isCollapsed &&
                      items.map((entry) => (
                        <UncommittedEntryRow
                          key={`${entry.area}:${entry.path}`}
                          entry={entry}
                          worktreePath={worktreePath}
                          onOpen={() => openUncommittedDiff(entry)}
                          onStage={() => void handleStage(entry.path)}
                          onUnstage={() => void handleUnstage(entry.path)}
                          onDiscard={() => void handleDiscard(entry.path)}
                        />
                      ))}
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
                  <ActionButton
                    icon={Layers}
                    title="Open all branch diffs"
                    onClick={(e) => {
                      e.stopPropagation()
                      if (activeWorktreeId && worktreePath && branchSummary) {
                        openBranchAllDiffs(activeWorktreeId, worktreePath, branchSummary)
                      }
                    }}
                  />
                }
              />
              {!collapsedSections.has('branch') &&
                branchEntries.map((entry) => (
                  <BranchEntryRow
                    key={`branch:${entry.path}`}
                    entry={entry}
                    onOpen={() => openCommittedDiff(entry)}
                  />
                ))}
            </div>
          )}
        </div>
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
  uncommittedCount,
  prInfo,
  onChangeBaseRef,
  onRetry
}: {
  summary: GitBranchCompareSummary | null
  uncommittedCount: number
  prInfo: PRInfo | null
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
      <span>{summary.changedFiles + uncommittedCount} files changed</span>
      {summary.commitsAhead !== undefined && (
        <span title={`Comparing against ${summary.baseRef}`}>
          {summary.commitsAhead} commits ahead
        </span>
      )}
      {prInfo && (
        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">
          PR #{prInfo.number}
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
  isCollapsed,
  onToggle,
  actions
}: {
  label: string
  count: number
  isCollapsed: boolean
  onToggle: () => void
  actions?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="group/section flex items-center pl-1 pr-3 py-1">
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
      </button>
      <div className="shrink-0 flex items-center">{actions}</div>
    </div>
  )
}

function UncommittedEntryRow({
  entry,
  worktreePath,
  onOpen,
  onStage,
  onUnstage,
  onDiscard
}: {
  entry: GitStatusEntry
  worktreePath: string
  onOpen: () => void
  onStage: () => void
  onUnstage: () => void
  onDiscard: () => void
}): React.JSX.Element {
  const StatusIcon = STATUS_ICONS[entry.status] ?? FileQuestion
  const fileName = basename(entry.path)
  const parentDir = dirname(entry.path)
  const dirPath = parentDir === '.' ? '' : parentDir
  const actions = getSourceControlActions(entry.area)

  return (
    <div
      className="group flex cursor-pointer items-center gap-1 pl-5 pr-3 py-1 transition-colors hover:bg-accent/40"
      draggable
      onDragStart={(e) => {
        const absolutePath = joinPath(worktreePath, entry.path)
        e.dataTransfer.setData('text/x-orca-file-path', absolutePath)
        e.dataTransfer.effectAllowed = 'copy'
      }}
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
      <div className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 flex items-center gap-0.5">
        {actions.includes('discard') && (
          <ActionButton
            icon={Undo2}
            title={entry.area === 'untracked' ? 'Revert untracked file' : 'Discard changes'}
            onClick={(event) => {
              event.stopPropagation()
              if (
                entry.area === 'untracked' &&
                !window.confirm(`Delete untracked file "${entry.path}"? This cannot be undone.`)
              ) {
                return
              }
              void onDiscard()
            }}
          />
        )}
        {actions.includes('stage') && (
          <ActionButton
            icon={Plus}
            title="Stage"
            onClick={(event) => {
              event.stopPropagation()
              void onStage()
            }}
          />
        )}
        {actions.includes('unstage') && (
          <ActionButton
            icon={Minus}
            title="Unstage"
            onClick={(event) => {
              event.stopPropagation()
              void onUnstage()
            }}
          />
        )}
      </div>
    </div>
  )
}

function BranchEntryRow({
  entry,
  onOpen
}: {
  entry: GitBranchChangeEntry
  onOpen: () => void
}): React.JSX.Element {
  const StatusIcon = STATUS_ICONS[entry.status] ?? FileQuestion
  const fileName = basename(entry.path)
  const parentDir = dirname(entry.path)
  const dirPath = parentDir === '.' ? '' : parentDir

  return (
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
