/* eslint-disable max-lines */
import React, { useMemo, useCallback, useRef, useState, useEffect, useLayoutEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, CircleX, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import WorktreeCard from './WorktreeCard'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { Worktree, Repo } from '../../../../shared/types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { buildWorktreeComparator } from './smart-sort'
import { type Row, buildRows, getGroupKeyForWorktree } from './worktree-list-groups'
import { computeVisibleWorktreeIds, setVisibleWorktreeIds } from './visible-worktrees'
import { estimateRowHeight } from './worktree-list-estimate'
import { useModifierHint } from '@/hooks/useModifierHint'

// How long to wait after a sortEpoch bump before actually re-sorting.
// Prevents jarring position shifts when background events (AI starting work,
// terminal title changes) trigger score recalculations.
const SORT_SETTLE_MS = 3_000

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
  const browserTabsByWorktree = useAppStore((s) =>
    showActiveOnly ? s.browserTabsByWorktree : null
  )

  const cardProps = useAppStore((s) => s.worktreeCardProperties)

  // PR cache is needed for PR-status grouping, recent sorting, search, and
  // estimateSize when the PR card property is visible.
  const prCache = useAppStore((s) =>
    groupBy === 'pr-status' || sortBy === 'recent' || searchQuery || cardProps.includes('pr')
      ? s.prCache
      : null
  )
  // Subscribe to issue cache only during active search to avoid unnecessary re-renders.
  const issueCache = useAppStore((s) => (searchQuery ? s.issueCache : null))

  const sortEpoch = useAppStore((s) => s.sortEpoch)

  // Count of non-archived worktrees — used to detect structural changes
  // (add/remove) vs. pure reorders (score shifts) so the debounce below
  // can apply immediately when the list shape changes.
  const worktreeCount = useMemo(() => {
    let count = 0
    for (const ws of Object.values(worktreesByRepo)) {
      for (const w of ws) {
        if (!w.isArchived) {
          count++
        }
      }
    }
    return count
  }, [worktreesByRepo])

  // Why debounce: sort scores include a time-decaying activity component.
  // Recomputing instantly on every sortEpoch bump (e.g. AI starting work,
  // terminal title changes) recalculates all scores with a fresh `now`,
  // causing worktrees to visibly jump even when the triggering event isn't
  // about the worktree the user is looking at.  Settling for a few seconds
  // lets rapid-fire events coalesce and prevents mid-interaction surprises.
  //
  // However, structural changes (worktree created or removed) must apply
  // immediately — a new worktree should appear at its correct sorted
  // position, not at the bottom for 3 seconds.
  const [debouncedSortEpoch, setDebouncedSortEpoch] = useState(sortEpoch)
  const prevWorktreeCountRef = useRef(worktreeCount)
  useEffect(() => {
    if (debouncedSortEpoch === sortEpoch) {
      return
    }

    // Detect add/remove by comparing worktree count.
    const structuralChange = worktreeCount !== prevWorktreeCountRef.current
    prevWorktreeCountRef.current = worktreeCount

    if (structuralChange) {
      setDebouncedSortEpoch(sortEpoch)
      return
    }

    const timer = setTimeout(() => setDebouncedSortEpoch(sortEpoch), SORT_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [sortEpoch, debouncedSortEpoch, worktreeCount])

  const scrollRef = useRef<HTMLDivElement>(null)
  // Why a latching ref: we need to distinguish "app just started, no PTYs
  // have spawned yet" from "user closed all terminals mid-session." The
  // former should use the persisted sortOrder; the latter should keep using
  // the live smart score. A point-in-time `hasAnyLivePty` check conflates
  // the two. This ref flips to true once any PTY is observed and never
  // reverts, so the cold-start path is only used on actual cold start.
  const sessionHasHadPty = useRef(false)

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

    // Why cold-start detection: the smart score is dominated by ephemeral
    // signals (running jobs +60, live terminals +12, needs attention +35)
    // that vanish after restart. Recomputing the smart score on cold start
    // produces a shuffled ordering because those signals are gone while
    // persistent ones (unread, linked PR) survive — changing relative ranks.
    // Instead, restore the pre-shutdown order from the persisted sortOrder
    // snapshot, and switch to the live smart score once PTYs start spawning.
    if (sortBy === 'recent' && !sessionHasHadPty.current) {
      const hasAnyLivePty = Object.values(state.tabsByWorktree)
        .flat()
        .some((t) => t.ptyId)
      if (hasAnyLivePty) {
        sessionHasHadPty.current = true
      } else {
        allWorktrees.sort(
          (a, b) => b.sortOrder - a.sortOrder || a.displayName.localeCompare(b.displayName)
        )
        return allWorktrees.map((w) => w.id)
      }
    }

    const currentRepoMap = new Map(state.repos.map((r) => [r.id, r]))
    const currentTabs = state.tabsByWorktree
    allWorktrees.sort(
      buildWorktreeComparator(sortBy, currentTabs, currentRepoMap, state.prCache, Date.now())
    )
    return allWorktrees.map((w) => w.id)
    // debouncedSortEpoch is an intentional trigger: it's not read inside the
    // memo, but its change signals that the sort order should be recomputed.
    // The debounce prevents jarring mid-interaction position shifts.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSortEpoch, sortBy, repos])

  // Persist the computed sort order so the sidebar can be restored after
  // restart. Only persist during live sessions (sessionHasHadPty latched) —
  // on cold start we are *reading* the persisted order, not overwriting it.
  useEffect(() => {
    if (sortBy !== 'recent' || sortedIds.length === 0 || !sessionHasHadPty.current) {
      return
    }
    void window.api.worktrees.persistSortOrder({ orderedIds: sortedIds })
  }, [sortedIds, sortBy])

  // Flatten, filter, and apply stable sort order via the shared utility so
  // the card order always matches the Cmd+1–9 shortcut numbering.
  const visibleWorktrees = useMemo(() => {
    const ids = computeVisibleWorktreeIds(worktreesByRepo, sortedIds, {
      filterRepoIds,
      searchQuery,
      showActiveOnly,
      tabsByWorktree,
      browserTabsByWorktree,
      activeWorktreeId,
      repoMap,
      prCache,
      issueCache
    })
    // Resolve IDs back to Worktree objects for rendering
    const allMap = new Map<string, Worktree>()
    for (const ws of Object.values(worktreesByRepo)) {
      for (const w of ws) {
        allMap.set(w.id, w)
      }
    }
    return ids.map((id) => allMap.get(id)).filter((w): w is Worktree => w != null)
  }, [
    worktreesByRepo,
    filterRepoIds,
    searchQuery,
    showActiveOnly,
    activeWorktreeId,
    repoMap,
    tabsByWorktree,
    browserTabsByWorktree,
    sortedIds,
    prCache,
    issueCache
  ])

  const worktrees = visibleWorktrees

  // Cmd+1–9 hint overlay: map worktree ID → hint number (1–9) for the first
  // 9 visible worktrees. Only populated while the user holds the modifier key.
  const { showHints } = useModifierHint()

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

  // Why: derive the rendered item order from the post-buildRows() row list,
  // not the flat `worktrees` array, because grouping (groupBy: 'repo' or
  // 'pr-status') can reorder cards into grouped sections. Using the flat
  // order would cause badge numbers and Cmd+1–9 shortcuts to not match
  // the visual card positions when grouping is active.
  const renderedWorktrees = useMemo(
    () =>
      rows
        .filter((r): r is Extract<Row, { type: 'item' }> => r.type === 'item')
        .map((r) => r.worktree),
    [rows]
  )

  // Why layout effect instead of effect: the global Cmd/Ctrl+1–9 key handler
  // can fire immediately after React commits the new grouped/collapsed order.
  // Publishing after paint leaves a brief window where the sidebar shows the
  // new numbering but the shortcut cache still points at the previous order.
  useLayoutEffect(() => {
    setVisibleWorktreeIds(renderedWorktrees.map((w) => w.id))
  }, [renderedWorktrees])

  const hintByWorktreeId = useMemo(() => {
    if (!showHints) {
      return null
    }
    const map = new Map<string, number>()
    const limit = Math.min(renderedWorktrees.length, 9)
    for (let i = 0; i < limit; i++) {
      map.set(renderedWorktrees[i].id, i + 1)
    }
    return map
  }, [showHints, renderedWorktrees])

  // ── TanStack Virtual ──────────────────────────────────────────
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // Dynamic height estimate — pixel constants coupled to WorktreeCard's
    // Tailwind classes (see coupling comment in WorktreeCard meta section).
    estimateSize: (index) => estimateRowHeight(rows[index], cardProps, repoMap, prCache),
    overscan: 10,
    // Why gap instead of padding on the wrapper: the virtualizer accounts for
    // the gap in its position calculations, guaranteeing consistent spacing
    // between cards regardless of estimation/measurement mismatches.
    gap: 6,
    getItemKey: (index) => {
      const row = rows[index]
      return row.type === 'header' ? `hdr:${row.key}` : `wt:${row.worktree.id}`
    }
  })

  // Invalidate cached sizes when async PR data arrives or card props change,
  // so the virtualizer re-measures and eliminates overlap / scroll jumps.
  useEffect(() => {
    if (!prCache) {
      return
    }
    virtualizer.measure()
  }, [prCache, virtualizer])
  useEffect(() => {
    virtualizer.measure()
  }, [cardProps, virtualizer])

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
                    'group mt-2 flex h-7 w-full items-center gap-1.5 px-1.5 text-left transition-all',
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
                            if (row.repo && isGitRepoKind(row.repo)) {
                              handleCreateForRepo(row.repo.id)
                            }
                          }}
                          disabled={row.repo ? !isGitRepoKind(row.repo) : false}
                        >
                          <Plus className="size-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" sideOffset={6}>
                        {row.repo && !isGitRepoKind(row.repo)
                          ? `${row.label} is opened as a folder`
                          : `Create worktree for ${row.label}`}
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
              className="absolute left-0 right-0"
              style={{ transform: `translateY(${vItem.start}px)` }}
            >
              <WorktreeCard
                worktree={row.worktree}
                repo={row.repo}
                isActive={activeWorktreeId === row.worktree.id}
                hideRepoBadge={groupBy === 'repo'}
                hintNumber={hintByWorktreeId?.get(row.worktree.id)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
})

export default WorktreeList
