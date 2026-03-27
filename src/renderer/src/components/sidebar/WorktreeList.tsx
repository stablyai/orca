import React, { useMemo, useCallback, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, CircleX, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import WorktreeCard from './WorktreeCard'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { Worktree, Repo } from '../../../../shared/types'
import { buildWorktreeComparator } from './smart-sort'
import {
  branchName,
  getPRGroupKey,
  type PRGroupKey,
  type Row,
  PR_GROUP_META,
  PR_GROUP_ORDER,
  REPO_GROUP_META,
  getGroupKeyForWorktree
} from './worktree-list-groups'

const WorktreeList = React.memo(function WorktreeList() {
  // ── Granular selectors (each is a primitive or shallow-stable ref) ──
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const repos = useAppStore((s) => s.repos)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const searchQuery = useAppStore((s) => s.searchQuery)
  const groupBy = useAppStore((s) => s.groupBy)
  const sortBy = useAppStore((s) => s.sortBy)
  const showActiveOnly = useAppStore((s) => s.showActiveOnly)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const openModal = useAppStore((s) => s.openModal)
  const pendingRevealWorktreeId = useAppStore((s) => s.pendingRevealWorktreeId)
  const clearPendingRevealWorktreeId = useAppStore((s) => s.clearPendingRevealWorktreeId)

  // Read tabsByWorktree when needed for filtering or sorting
  const needsTabs = showActiveOnly || sortBy === 'recent' || sortBy === 'smart'
  const tabsByWorktree = useAppStore((s) => (needsTabs ? s.tabsByWorktree : null))

  // PR cache only when grouping by pr-status
  const prCache = useAppStore((s) => (groupBy === 'pr-status' ? s.prCache : null))

  const scrollRef = useRef<HTMLDivElement>(null)

  const repoMap = useMemo(() => {
    const m = new Map<string, Repo>()
    for (const r of repos) {
      m.set(r.id, r)
    }
    return m
  }, [repos])

  // Flatten, filter, sort
  const worktrees = useMemo(() => {
    let all: Worktree[] = Object.values(worktreesByRepo).flat()

    // Filter archived
    all = all.filter((w) => !w.isArchived)

    // Filter by repo
    if (filterRepoIds.length > 0) {
      const selectedRepoIds = new Set(filterRepoIds)
      all = all.filter((w) => selectedRepoIds.has(w.repoId))
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
    all.sort(buildWorktreeComparator(sortBy, tabsByWorktree, repoMap, activeWorktreeId))

    return all
  }, [
    worktreesByRepo,
    filterRepoIds,
    searchQuery,
    showActiveOnly,
    sortBy,
    repoMap,
    tabsByWorktree,
    activeWorktreeId
  ])

  // Collapsed group state
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
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
      if (!grouped.has(key)) {
        grouped.set(key, { label, items: [], repo })
      }
      grouped.get(key)!.items.push(w)
    }

    const orderedGroups: [string, { label: string; items: Worktree[]; repo?: Repo }][] = []
    if (groupBy === 'pr-status') {
      for (const prGroup of PR_GROUP_ORDER) {
        const key = `pr:${prGroup}`
        const group = grouped.get(key)
        if (group) {
          orderedGroups.push([key, group])
        }
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
              tone: REPO_GROUP_META.tone,
              icon: REPO_GROUP_META.icon,
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
  }, [groupBy, worktrees, repoMap, prCache, collapsedGroups])

  // ── TanStack Virtual ──────────────────────────────────────────
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index].type === 'header' ? 42 : 56 + 4),
    overscan: 10,
    getItemKey: (index) => {
      const row = rows[index]
      return row.type === 'header' ? `hdr:${row.key}` : `wt:${row.worktree.id}`
    }
  })

  React.useEffect(() => {
    if (!pendingRevealWorktreeId) {
      return
    }

    // Uncollapse the group containing the target worktree
    if (groupBy !== 'none') {
      const targetWorktree = worktrees.find((w) => w.id === pendingRevealWorktreeId)
      if (targetWorktree) {
        const groupKey = getGroupKeyForWorktree(groupBy, targetWorktree, repoMap, prCache)
        if (groupKey) {
          setCollapsedGroups((prev) => {
            if (!prev.has(groupKey)) {
              return prev
            }
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

  const hasFilters = !!(searchQuery || showActiveOnly || filterRepoIds.length)
  const setSearchQuery = useAppStore((s) => s.setSearchQuery)
  const setShowActiveOnly = useAppStore((s) => s.setShowActiveOnly)
  const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)

  const clearFilters = useCallback(() => {
    setSearchQuery('')
    setShowActiveOnly(false)
    setFilterRepoIds([])
  }, [setSearchQuery, setShowActiveOnly, setFilterRepoIds])

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
    <div ref={scrollRef} className="flex-1 overflow-auto px-1 pt-px scrollbar-sleek scroll-smooth">
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
                    'group mb-1 mt-2 flex h-7 w-full items-center gap-1.5 px-1.5 text-left transition-all',
                    row.repo ? 'overflow-hidden' : row.tone
                  )}
                  onClick={() => toggleGroup(row.key)}
                >
                  <div
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded-[4px]',
                      row.repo ? 'text-foreground' : ''
                    )}
                    style={row.repo ? { color: row.repo.badgeColor } : undefined}
                  >
                    <row.icon className="size-3" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <div className="truncate text-[13px] font-semibold leading-none lowercase">
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
                          className="mr-0.5 size-5 shrink-0 rounded-md text-muted-foreground hover:bg-accent/70 hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                          aria-label={`Create worktree for ${row.label}`}
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            if (row.repo) {
                              handleCreateForRepo(row.repo.id)
                            }
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

                  <div className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/60 opacity-0 group-hover:opacity-100 transition-opacity">
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
              className="absolute left-0 right-0 pb-1"
              style={{ transform: `translateY(${vItem.start}px)` }}
            >
              <WorktreeCard
                worktree={row.worktree}
                repo={row.repo}
                isActive={activeWorktreeId === row.worktree.id}
                hideRepoBadge={groupBy === 'repo'}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
})

export default WorktreeList
