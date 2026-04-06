import React, { useMemo, useCallback, useRef, useState, useEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, CircleX, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import WorktreeCard from './WorktreeCard'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { Worktree, Repo } from '../../../../shared/types'
import { buildWorktreeComparator } from './smart-sort'
import { matchesSearch, type Row, buildRows, getGroupKeyForWorktree } from './worktree-list-groups'

const WorktreeList = React.memo(function WorktreeList() {
  // ── Granular selectors (each is a primitive or shallow-stable ref) ──
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const repos = useAppStore((s) => s.repos)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const searchQuery = useAppStore((s) => s.searchQuery)
  const groupBy = useAppStore((s) => s.groupBy)
  const sortBy = useAppStore((s) => s.sortBy)
  const showActiveOnly = useAppStore((s) => s.showActiveOnly)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const openModal = useAppStore((s) => s.openModal)
  const pendingRevealWorktreeId = useAppStore((s) => s.pendingRevealWorktreeId)
  const clearPendingRevealWorktreeId = useAppStore((s) => s.clearPendingRevealWorktreeId)

  // Read tabsByWorktree when needed for filtering or sorting
  const needsTabs = showActiveOnly || sortBy === 'recent'
  const tabsByWorktree = useAppStore((s) => (needsTabs ? s.tabsByWorktree : null))

  // PR cache is needed for PR-status grouping and for recent sorting, which
  // incorporates whether the current branch has a live PR attached.
  const prCache = useAppStore((s) =>
    groupBy === 'pr-status' || sortBy === 'recent' || searchQuery ? s.prCache : null
  )
  // Subscribe to issue cache only during active search to avoid unnecessary re-renders.
  const issueCache = useAppStore((s) => (searchQuery ? s.issueCache : null))

  const sortEpoch = useAppStore((s) => s.sortEpoch)
  const scrollRef = useRef<HTMLDivElement>(null)

  const repoMap = useMemo(() => {
    const m = new Map<string, Repo>()
    for (const r of repos) {
      m.set(r.id, r)
    }
    return m
  }, [repos])

  // ── Stable sort order ──────────────────────────────────────────
  // The sort order is cached and only recomputed when `sortEpoch` changes
  // (worktree add/remove, terminal activity, backend refresh, etc.).
  // Why: explicit selection also triggers local side-effects like clearing
  // `isUnread` and force-refreshing the branch PR cache. Those updates are
  // useful for card contents, but they must not participate in ordering or a
  // sequence of clicks will keep reshuffling the sidebar underneath the user.
  //
  // Why useMemo instead of useEffect: the sort order must be computed
  // synchronously *before* the worktrees memo reads it, otherwise the
  // first render (and epoch bumps) would use stale/empty data from the ref.
  const sortedIds = useMemo(() => {
    const state = useAppStore.getState()
    const allWorktrees: Worktree[] = Object.values(state.worktreesByRepo)
      .flat()
      .filter((w) => !w.isArchived)
    const currentRepoMap = new Map(state.repos.map((r) => [r.id, r]))
    const currentTabs = state.tabsByWorktree
    allWorktrees.sort(
      buildWorktreeComparator(sortBy, currentTabs, currentRepoMap, state.prCache, Date.now())
    )
    return allWorktrees.map((w) => w.id)
    // sortEpoch is an intentional trigger: it's not read inside the memo, but
    // its change signals that the sort order should be recomputed.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [sortEpoch, sortBy, repos])

  // Flatten, filter, and apply stable sort order
  const visibleWorktrees = useMemo(() => {
    let all: Worktree[] = Object.values(worktreesByRepo).flat()

    // Filter archived
    all = all.filter((w) => !w.isArchived)

    // Filter by repo
    if (filterRepoIds.length > 0) {
      const selectedRepoIds = new Set(filterRepoIds)
      all = all.filter((w) => selectedRepoIds.has(w.repoId))
    }

    // Filter by search — matches against displayName, branch, repo, comment,
    // PR number/title, and issue number/title (see matchesSearch).
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      all = all.filter((w) => matchesSearch(w, q, repoMap, prCache, issueCache))
    }

    // Filter active only
    if (showActiveOnly) {
      all = all.filter((w) => {
        const tabs = tabsByWorktree?.[w.id] ?? []
        return tabs.some((t) => t.ptyId)
      })
    }

    // Apply cached sort order. Items not yet in the cache (e.g. brand-new
    // worktrees before the next sortEpoch bump) are appended at the end.
    const orderIndex = new Map(sortedIds.map((id, i) => [id, i]))
    all.sort((a, b) => {
      const ai = orderIndex.get(a.id) ?? Infinity
      const bi = orderIndex.get(b.id) ?? Infinity
      return ai - bi
    })

    return all
  }, [
    worktreesByRepo,
    filterRepoIds,
    searchQuery,
    showActiveOnly,
    repoMap,
    tabsByWorktree,
    sortedIds,
    prCache,
    issueCache
  ])

  const worktrees = visibleWorktrees

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
  const rows: Row[] = useMemo(
    () => buildRows(groupBy, worktrees, repoMap, prCache, collapsedGroups),
    [groupBy, worktrees, repoMap, prCache, collapsedGroups]
  )

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

  const navigateWorktree = useCallback(
    (direction: 'up' | 'down') => {
      const worktreeRows = rows.filter(
        (r): r is Extract<Row, { type: 'item' }> => r.type === 'item'
      )
      if (worktreeRows.length === 0) {
        return
      }

      let nextIndex = 0
      const currentIndex = worktreeRows.findIndex((r) => r.worktree.id === activeWorktreeId)

      if (currentIndex !== -1) {
        if (direction === 'up') {
          nextIndex = currentIndex - 1
          if (nextIndex < 0) {
            nextIndex = worktreeRows.length - 1
          }
        } else {
          nextIndex = currentIndex + 1
          if (nextIndex >= worktreeRows.length) {
            nextIndex = 0
          }
        }
      }

      const nextWorktreeId = worktreeRows[nextIndex].worktree.id
      setActiveWorktree(nextWorktreeId)

      const rowIndex = rows.findIndex((r) => r.type === 'item' && r.worktree.id === nextWorktreeId)
      if (rowIndex !== -1) {
        virtualizer.scrollToIndex(rowIndex, { align: 'auto' })
      }
    },
    [rows, activeWorktreeId, setActiveWorktree, virtualizer]
  )

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = navigator.userAgent.includes('Mac') ? e.metaKey : e.ctrlKey
      if (mod && !e.shiftKey && e.key === '0') {
        scrollRef.current?.focus()
        e.preventDefault()
        return
      }

      if (mod && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        navigateWorktree(e.key === 'ArrowUp' ? 'up' : 'down')
        e.preventDefault()
      }
    }

    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [navigateWorktree])

  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // Why: only capture bare arrow keys when the list container itself is
        // focused. If focus is on an inner input or button, arrow keys should
        // perform their native function (e.g. cursor movement in text fields).
        if (e.target !== e.currentTarget) {
          return
        }
        navigateWorktree(e.key === 'ArrowUp' ? 'up' : 'down')
        e.preventDefault()
      } else if (e.key === 'Enter') {
        const helper = document.querySelector(
          '.xterm-helper-textarea'
        ) as HTMLTextAreaElement | null
        if (helper) {
          helper.focus()
        }
        e.preventDefault()
      }
    },
    [navigateWorktree]
  )

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
    <div
      ref={scrollRef}
      tabIndex={0}
      onKeyDown={handleContainerKeyDown}
      className="flex-1 overflow-auto px-1 scrollbar-sleek scroll-smooth outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset pt-px"
    >
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
