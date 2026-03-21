import React, { useMemo, useCallback, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  ChevronDown,
  CircleCheckBig,
  CircleDot,
  CircleX,
  FolderGit2,
  GitPullRequest,
  Plus
} from 'lucide-react'
import { useAppStore } from '@/store'
import WorktreeCard from './WorktreeCard'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { Worktree, Repo } from '../../../../shared/types'

function branchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

// ── Row types for the virtualizer ───────────────────────────────
type GroupHeaderRow = {
  type: 'header'
  key: string
  label: string
  count: number
  tone: string
  icon: React.ComponentType<{ className?: string }>
  repo?: Repo
}
type WorktreeRow = { type: 'item'; worktree: Worktree; repo: Repo | undefined }
type Row = GroupHeaderRow | WorktreeRow

type PRGroupKey = 'done' | 'in-review' | 'in-progress' | 'closed'

const PR_GROUP_ORDER: PRGroupKey[] = ['done', 'in-review', 'in-progress', 'closed']

const PR_GROUP_META: Record<
  PRGroupKey,
  {
    label: string
    icon: React.ComponentType<{ className?: string }>
    tone: string
  }
> = {
  done: {
    label: 'Done',
    icon: CircleCheckBig,
    tone: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  },
  'in-review': {
    label: 'In review',
    icon: GitPullRequest,
    tone: 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-200'
  },
  'in-progress': {
    label: 'In progress',
    icon: CircleDot,
    tone: 'border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-200'
  },
  closed: {
    label: 'Closed',
    icon: CircleX,
    tone: 'border-zinc-500/20 bg-zinc-500/10 text-zinc-600 dark:text-zinc-300'
  }
}

function getPRGroupKey(
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null
): PRGroupKey {
  const repo = repoMap.get(worktree.repoId)
  const branch = branchName(worktree.branch)
  const cacheKey = repo ? `${repo.path}::${branch}` : ''
  const prEntry =
    cacheKey && prCache
      ? (prCache[cacheKey] as { data?: { state?: string } } | undefined)
      : undefined
  const pr = prEntry?.data

  if (!pr) return 'in-progress'
  if (pr.state === 'merged') return 'done'
  if (pr.state === 'closed') return 'closed'
  if (pr.state === 'draft') return 'in-progress'
  return 'in-review'
}

function getGroupKeyForWorktree(
  groupBy: 'none' | 'repo' | 'pr-status',
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prCache: Record<string, unknown> | null
): string | null {
  if (groupBy === 'none') return null
  if (groupBy === 'repo') return `repo:${worktree.repoId}`
  return `pr:${getPRGroupKey(worktree, repoMap, prCache)}`
}

const WorktreeList = React.memo(function WorktreeList() {
  // ── Granular selectors (each is a primitive or shallow-stable ref) ──
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const repos = useAppStore((s) => s.repos)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const searchQuery = useAppStore((s) => s.searchQuery)
  const groupBy = useAppStore((s) => s.groupBy)
  const sortBy = useAppStore((s) => s.sortBy)
  const showActiveOnly = useAppStore((s) => s.showActiveOnly)
  const filterRepoId = useAppStore((s) => s.filterRepoId)
  const openModal = useAppStore((s) => s.openModal)
  const pendingRevealWorktreeId = useAppStore((s) => s.pendingRevealWorktreeId)
  const clearPendingRevealWorktreeId = useAppStore((s) => s.clearPendingRevealWorktreeId)

  // Only read tabsByWorktree when showActiveOnly is on (avoid subscription otherwise)
  const tabsByWorktree = useAppStore((s) => (showActiveOnly ? s.tabsByWorktree : null))

  // PR cache only when grouping by pr-status
  const prCache = useAppStore((s) => (groupBy === 'pr-status' ? s.prCache : null))

  const scrollRef = useRef<HTMLDivElement>(null)

  const repoMap = useMemo(() => {
    const m = new Map<string, Repo>()
    for (const r of repos) m.set(r.id, r)
    return m
  }, [repos])

  // Flatten, filter, sort
  const worktrees = useMemo(() => {
    let all: Worktree[] = Object.values(worktreesByRepo).flat()

    // Filter archived
    all = all.filter((w) => !w.isArchived)

    // Filter by repo
    if (filterRepoId) {
      all = all.filter((w) => w.repoId === filterRepoId)
    }

    // Filter by search
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      all = all.filter(
        (w) =>
          w.displayName.toLowerCase().includes(q) ||
          branchName(w.branch).toLowerCase().includes(q) ||
          (repoMap.get(w.repoId)?.displayName ?? '').toLowerCase().includes(q)
      )
    }

    // Filter active only
    if (showActiveOnly) {
      all = all.filter((w) => {
        const tabs = tabsByWorktree?.[w.id] ?? []
        return tabs.some((t) => t.ptyId)
      })
    }

    // Sort
    all.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.displayName.localeCompare(b.displayName)
        case 'recent':
          return b.sortOrder - a.sortOrder
        case 'repo': {
          const ra = repoMap.get(a.repoId)?.displayName ?? ''
          const rb = repoMap.get(b.repoId)?.displayName ?? ''
          const cmp = ra.localeCompare(rb)
          return cmp !== 0 ? cmp : a.displayName.localeCompare(b.displayName)
        }
        default:
          return 0
      }
    })

    return all
  }, [worktreesByRepo, filterRepoId, searchQuery, showActiveOnly, sortBy, repoMap, tabsByWorktree])

  // Collapsed group state
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // Build flat row list for virtualizer
  const rows: Row[] = useMemo(() => {
    const result: Row[] = []

    if (groupBy === 'none') {
      for (const w of worktrees) {
        result.push({ type: 'item', worktree: w, repo: repoMap.get(w.repoId) })
      }
      return result
    }

    const grouped = new Map<string, { label: string; items: Worktree[]; repo?: Repo }>()
    for (const w of worktrees) {
      let key: string
      let label: string
      let repo: Repo | undefined
      if (groupBy === 'repo') {
        repo = repoMap.get(w.repoId)
        key = `repo:${w.repoId}`
        label = repo?.displayName ?? 'Unknown'
      } else {
        const prGroup = getPRGroupKey(w, repoMap, prCache)
        key = `pr:${prGroup}`
        label = PR_GROUP_META[prGroup].label
      }
      if (!grouped.has(key)) grouped.set(key, { label, items: [], repo })
      grouped.get(key)!.items.push(w)
    }

    const orderedGroups: Array<[string, { label: string; items: Worktree[]; repo?: Repo }]> = []
    if (groupBy === 'pr-status') {
      for (const prGroup of PR_GROUP_ORDER) {
        const key = `pr:${prGroup}`
        const group = grouped.get(key)
        if (group) orderedGroups.push([key, group])
      }
    } else {
      orderedGroups.push(...Array.from(grouped.entries()))
    }

    for (const [key, group] of orderedGroups) {
      const isCollapsed = collapsedGroups.has(key)
      const repo = group.repo
      const header =
        groupBy === 'repo'
          ? {
              type: 'header' as const,
              key,
              label: group.label,
              count: group.items.length,
              tone: 'border-border/70 bg-background/70 text-foreground',
              icon: FolderGit2,
              repo
            }
          : (() => {
              const prGroup = key.replace(/^pr:/, '') as PRGroupKey
              const meta = PR_GROUP_META[prGroup]
              return {
                type: 'header' as const,
                key,
                label: meta.label,
                count: group.items.length,
                tone: meta.tone,
                icon: meta.icon
              }
            })()

      result.push(header)
      if (!isCollapsed) {
        for (const w of group.items) {
          result.push({ type: 'item', worktree: w, repo: repoMap.get(w.repoId) })
        }
      }
    }

    return result
  }, [groupBy, worktrees, repoMap, prCache, collapsedGroups, tabsByWorktree])

  // ── TanStack Virtual ──────────────────────────────────────────
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index].type === 'header' ? 38 : 56),
    overscan: 10,
    getItemKey: (index) => {
      const row = rows[index]
      return row.type === 'header' ? `hdr:${row.key}` : `wt:${row.worktree.id}`
    }
  })

  React.useEffect(() => {
    if (!pendingRevealWorktreeId) return

    // Uncollapse the group containing the target worktree
    if (groupBy !== 'none') {
      const targetWorktree = worktrees.find((w) => w.id === pendingRevealWorktreeId)
      if (targetWorktree) {
        const groupKey = getGroupKeyForWorktree(groupBy, targetWorktree, repoMap, prCache)
        if (groupKey) {
          setCollapsedGroups((prev) => {
            if (!prev.has(groupKey)) return prev
            const next = new Set(prev)
            next.delete(groupKey)
            return next
          })
        }
      }
    }

    // Scroll to the target after the group uncollapse re-render settles
    requestAnimationFrame(() => {
      const targetIndex = rows.findIndex(
        (row) => row.type === 'item' && row.worktree.id === pendingRevealWorktreeId
      )
      if (targetIndex !== -1) {
        virtualizer.scrollToIndex(targetIndex, { align: 'center' })
      }
      clearPendingRevealWorktreeId()
    })
  }, [
    pendingRevealWorktreeId,
    groupBy,
    worktrees,
    repoMap,
    prCache,
    rows,
    virtualizer,
    clearPendingRevealWorktreeId
  ])

  const handleCreateForRepo = useCallback(
    (repoId: string) => {
      openModal('create-worktree', { preselectedRepoId: repoId })
    },
    [openModal]
  )

  const hasFilters = !!(searchQuery || showActiveOnly || filterRepoId)
  const setSearchQuery = useAppStore((s) => s.setSearchQuery)
  const setShowActiveOnly = useAppStore((s) => s.setShowActiveOnly)
  const setFilterRepoId = useAppStore((s) => s.setFilterRepoId)

  const clearFilters = useCallback(() => {
    setSearchQuery('')
    setShowActiveOnly(false)
    setFilterRepoId(null)
  }, [setSearchQuery, setShowActiveOnly, setFilterRepoId])

  if (worktrees.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-6 text-center text-[11px] text-muted-foreground">
        <span>No worktrees found</span>
        {hasFilters && (
          <button
            onClick={clearFilters}
            className="inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-[11px] px-2.5 py-1 rounded-md cursor-pointer hover:bg-accent transition-colors"
          >
            <CircleX className="size-3.5" />
            Clear Filters
          </button>
        )}
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto px-1 scrollbar-sleek scroll-smooth">
      <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
        {virtualizer.getVirtualItems().map((vItem) => {
          const row = rows[vItem.index]

          if (row.type === 'header') {
            return (
              <div
                key={vItem.key}
                data-index={vItem.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 right-0"
                style={{ transform: `translateY(${vItem.start}px)` }}
              >
                <button
                  className={cn(
                    'group mx-1 mt-1.5 flex h-8 w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg border px-2 py-1 text-left transition-all hover:brightness-110',
                    row.tone,
                    row.repo ? 'overflow-hidden' : ''
                  )}
                  onClick={() => toggleGroup(row.key)}
                  style={
                    row.repo
                      ? {
                          backgroundImage: `linear-gradient(135deg, ${row.repo.badgeColor}26 0%, ${row.repo.badgeColor}12 52%, rgba(0,0,0,0) 100%)`,
                          borderColor: `${row.repo.badgeColor}44`
                        }
                      : undefined
                  }
                >
                  <div
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded-md border',
                      row.repo ? 'bg-black/10 text-foreground border-white/10' : 'bg-black/10'
                    )}
                    style={row.repo ? { color: row.repo.badgeColor } : undefined}
                  >
                    <row.icon className="size-3" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <div className="truncate text-[11px] font-semibold leading-none">
                        {row.label}
                      </div>
                      <div className="rounded-full bg-black/12 px-1.5 py-0.5 text-[9px] font-medium leading-none text-muted-foreground/90">
                        {row.count}
                      </div>
                    </div>
                  </div>

                  {row.repo ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="mr-0.5 size-5 shrink-0 rounded-md border border-white/10 bg-black/10 text-foreground hover:bg-black/20"
                          aria-label={`Create worktree for ${row.label}`}
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            if (row.repo) handleCreateForRepo(row.repo.id)
                          }}
                        >
                          <Plus className="size-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" sideOffset={6}>
                        Create worktree for {row.label}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}

                  <div className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/90">
                    <ChevronDown
                      className={cn(
                        'size-3.5 transition-transform',
                        collapsedGroups.has(row.key) && '-rotate-90'
                      )}
                    />
                  </div>
                </button>
              </div>
            )
          }

          return (
            <div
              key={vItem.key}
              data-index={vItem.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 right-0"
              style={{ transform: `translateY(${vItem.start}px)` }}
            >
              <WorktreeCard
                worktree={row.worktree}
                repo={row.repo}
                isActive={activeWorktreeId === row.worktree.id}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
})

export default WorktreeList
