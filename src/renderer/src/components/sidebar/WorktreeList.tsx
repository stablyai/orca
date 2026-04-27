/* eslint-disable max-lines */
import React, { useMemo, useCallback, useRef, useState, useEffect, useLayoutEffect } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, CircleX, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import {
  getAllWorktreesFromState,
  useAllWorktrees,
  useRepoMap,
  useWorktreeMap
} from '@/store/selectors'
import WorktreeCard from './WorktreeCard'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { Worktree, Repo } from '../../../../shared/types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { AGENT_DASHBOARD_ENABLED } from '../../../../shared/constants'
import {
  buildExplicitEntriesByTabId,
  buildWorktreeComparator,
  computeSmartScore
} from './smart-sort'
import {
  type GroupHeaderRow,
  type Row,
  ALL_GROUP_KEY,
  PINNED_GROUP_KEY,
  buildRows,
  getGroupKeyForWorktree
} from './worktree-list-groups'
import { computeVisibleWorktreeIds, setVisibleWorktreeIds } from './visible-worktrees'
import { useModifierHint } from '@/hooks/useModifierHint'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'

// How long to wait after a sortEpoch bump before actually re-sorting.
// Prevents jarring position shifts when background events (AI starting work,
// terminal title changes) trigger score recalculations.
const SORT_SETTLE_MS = 3_000

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  // xterm uses a hidden textarea for terminal input. Treating it like a normal
  // text field would make the sidebar's app-level worktree shortcuts unreachable.
  if (target.classList.contains('xterm-helper-textarea')) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }

  return (
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
    null
  )
}

function getWorktreeOptionId(worktreeId: string): string {
  return `worktree-list-option-${encodeURIComponent(worktreeId)}`
}

type VirtualizedWorktreeViewportProps = {
  rows: Row[]
  activeWorktreeId: string | null
  groupBy: 'none' | 'repo' | 'pr-status'
  toggleGroup: (key: string) => void
  collapsedGroups: Set<string>
  handleCreateForRepo: (repoId: string) => void
  hintByWorktreeId: Map<string, number> | null
  activeModal: string
  pendingRevealWorktreeId: string | null
  clearPendingRevealWorktreeId: () => void
  worktrees: Worktree[]
  repoMap: Map<string, Repo>
  prCache: Record<string, unknown> | null
}

const VirtualizedWorktreeViewport = React.memo(function VirtualizedWorktreeViewport({
  rows,
  activeWorktreeId,
  groupBy,
  toggleGroup,
  collapsedGroups,
  handleCreateForRepo,
  hintByWorktreeId,
  activeModal,
  pendingRevealWorktreeId,
  clearPendingRevealWorktreeId,
  worktrees,
  repoMap,
  prCache
}: VirtualizedWorktreeViewportProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeWorktreeRowIndex = useMemo(
    () => rows.findIndex((row) => row.type === 'item' && row.worktree.id === activeWorktreeId),
    [rows, activeWorktreeId]
  )

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 10,
    gap: 6,
    getItemKey: (index) => {
      const row = rows[index]
      if (!row) {
        return `__stale_${index}`
      }
      return row.type === 'header' ? `hdr:${row.key}` : `wt:${row.worktree.id}`
    }
  })

  React.useEffect(() => {
    if (!pendingRevealWorktreeId) {
      return
    }

    {
      const targetWorktree = worktrees.find((w) => w.id === pendingRevealWorktreeId)
      if (targetWorktree?.isPinned) {
        // Why: pinned worktrees live in the dedicated "Pinned" section regardless
        // of their PR-status / repo group. Only uncollapse the Pinned header
        // itself — expanding the underlying status group would be surprising since
        // the user intentionally collapsed it.
        if (collapsedGroups.has(PINNED_GROUP_KEY)) {
          toggleGroup(PINNED_GROUP_KEY)
        }
      } else if (targetWorktree && groupBy !== 'none') {
        const groupKey = getGroupKeyForWorktree(groupBy, targetWorktree, repoMap, prCache)
        if (groupKey && collapsedGroups.has(groupKey)) {
          toggleGroup(groupKey)
        }
      } else if (targetWorktree && groupBy === 'none') {
        // Why: when any worktree is pinned, buildRows emits a sibling "All"
        // header for the unpinned block (see worktree-list-groups.ts). If that
        // header is collapsed, revealing an unpinned target would otherwise
        // leave it hidden — uncollapse it so the card is actually visible.
        if (collapsedGroups.has(ALL_GROUP_KEY)) {
          toggleGroup(ALL_GROUP_KEY)
        }
      }
    }

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
    clearPendingRevealWorktreeId,
    toggleGroup,
    collapsedGroups
  ])

  const prCacheLen = useAppStore((s) => Object.keys(s.prCache).length)
  const issueCacheLen = useAppStore((s) => Object.keys(s.issueCache).length)

  useLayoutEffect(() => {
    virtualizer.elementsCache.forEach((element) => {
      const idx = parseInt(element.getAttribute('data-index') ?? '', 10)
      if (Number.isNaN(idx) || idx >= rows.length) {
        return
      }
      virtualizer.measureElement(element)
    })
  }, [prCacheLen, issueCacheLen, virtualizer, rows.length])

  const navigateWorktree = useCallback(
    (direction: 'up' | 'down') => {
      // Why: derive the cycling order from an all-expanded layout, not the
      // rendered rows. Otherwise Cmd+Shift+Up/Down would skip any worktree
      // hidden in a collapsed group — in particular it couldn't cross the
      // Pinned/All boundary when either section is collapsed. Reveal will
      // uncollapse the target section (see pendingRevealWorktreeId effect).
      const worktreeRows = buildRows(
        groupBy,
        worktrees,
        repoMap,
        prCache,
        new Set<string>()
      ).filter((r): r is Extract<Row, { type: 'item' }> => r.type === 'item')
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
      // Why: keyboard cycling between worktrees is still real navigation, so
      // it must flow through the same activation helper that records history.
      activateAndRevealWorktree(nextWorktreeId)

      const rowIndex = rows.findIndex((r) => r.type === 'item' && r.worktree.id === nextWorktreeId)
      if (rowIndex !== -1) {
        virtualizer.scrollToIndex(rowIndex, { align: 'auto' })
      }
    },
    [rows, activeWorktreeId, virtualizer, groupBy, worktrees, repoMap, prCache]
  )

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (activeModal !== 'none' || isEditableTarget(e.target)) {
        return
      }

      const mod = navigator.userAgent.includes('Mac')
        ? e.metaKey && !e.ctrlKey
        : e.ctrlKey && !e.metaKey
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
  }, [activeModal, navigateWorktree])

  const handleContainerKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
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

  const firstHeaderIndex = useMemo(() => rows.findIndex((r) => r.type === 'header'), [rows])

  const virtualItems = virtualizer.getVirtualItems()
  const activeDescendantId =
    activeWorktreeId != null &&
    activeWorktreeRowIndex !== -1 &&
    virtualItems.some((item) => item.index === activeWorktreeRowIndex)
      ? getWorktreeOptionId(activeWorktreeId)
      : undefined

  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      role="listbox"
      aria-label="Worktrees"
      aria-orientation="vertical"
      aria-activedescendant={activeDescendantId}
      onKeyDown={handleContainerKeyDown}
      className="flex-1 overflow-auto pl-1 pr-2 outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset pt-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <div
        role="presentation"
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualItems.map((vItem) => {
          const row = rows[vItem.index]

          if (row.type === 'header') {
            return (
              <div
                key={vItem.key}
                role="presentation"
                data-index={vItem.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 right-0"
                style={{ transform: `translateY(${vItem.start}px)` }}
              >
                <div
                  role="button"
                  tabIndex={0}
                  className={cn(
                    'group flex h-7 w-full items-center gap-1.5 px-1.5 text-left transition-all cursor-pointer',
                    // First header sits right under the sidebar search bar, which
                    // already supplies its own spacing — only offset secondary
                    // group headers.
                    vItem.index !== firstHeaderIndex && 'mt-2',
                    row.repo ? 'overflow-hidden' : row.tone
                  )}
                  onClick={() => toggleGroup(row.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      toggleGroup(row.key)
                    }
                  }}
                >
                  {row.icon ? (
                    <div
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded-[4px]',
                        row.repo ? 'text-foreground' : ''
                      )}
                      style={row.repo ? { color: row.repo.badgeColor } : undefined}
                    >
                      <row.icon className="size-3" />
                    </div>
                  ) : null}

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <div className="truncate text-[13px] font-semibold leading-none capitalize">
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
                </div>
              </div>
            )
          }

          return (
            <div
              key={vItem.key}
              id={getWorktreeOptionId(row.worktree.id)}
              role="option"
              aria-selected={activeWorktreeId === row.worktree.id}
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

const WorktreeList = React.memo(function WorktreeList() {
  // ── Granular selectors (each is a primitive or shallow-stable ref) ──
  const allWorktrees = useAllWorktrees()
  const repoMap = useRepoMap()
  const worktreeMap = useWorktreeMap()
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const searchQuery = useAppStore((s) => s.searchQuery)
  const groupBy = useAppStore((s) => s.groupBy)
  const sortBy = useAppStore((s) => s.sortBy)
  const showActiveOnly = useAppStore((s) => s.showActiveOnly)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const openModal = useAppStore((s) => s.openModal)
  const activeView = useAppStore((s) => s.activeView)
  const activeModal = useAppStore((s) => s.activeModal)
  const pendingRevealWorktreeId = useAppStore((s) => s.pendingRevealWorktreeId)
  const clearPendingRevealWorktreeId = useAppStore((s) => s.clearPendingRevealWorktreeId)

  // Read tabsByWorktree when needed for filtering or sorting
  const needsTabs = showActiveOnly || sortBy === 'smart'
  const tabsByWorktree = useAppStore((s) => (needsTabs ? s.tabsByWorktree : null))
  const browserTabsByWorktree = useAppStore((s) =>
    showActiveOnly ? s.browserTabsByWorktree : null
  )

  const cardProps = useAppStore((s) => s.worktreeCardProperties)

  // PR cache is needed for PR-status grouping, smart sorting, search,
  // and when the PR card property is visible.
  const prCache = useAppStore((s) =>
    groupBy === 'pr-status' || sortBy === 'smart' || searchQuery || cardProps.includes('pr')
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
    for (const worktree of allWorktrees) {
      if (!worktree.isArchived) {
        count++
      }
    }
    return count
  }, [allWorktrees])

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

  // Why a latching ref: we need to distinguish "app just started, no PTYs
  // have spawned yet" from "user closed all terminals mid-session." The
  // former should use the persisted sortOrder; the latter should keep using
  // the live smart score. A point-in-time `hasAnyLivePty` check conflates
  // the two. This ref flips to true once any PTY is observed and never
  // reverts, so the cold-start path is only used on actual cold start.
  const sessionHasHadPty = useRef(false)

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
    const nonArchivedWorktrees = getAllWorktreesFromState(state).filter(
      (worktree) => !worktree.isArchived
    )

    // Why cold-start detection: the smart score is dominated by ephemeral
    // signals (running jobs +60, live terminals +12, needs attention +35)
    // that vanish after restart. Recomputing the smart score on cold start
    // produces a shuffled ordering because those signals are gone while
    // persistent ones (unread, linked PR) survive — changing relative ranks.
    // Instead, restore the pre-shutdown order from the persisted sortOrder
    // snapshot, and switch to the live smart score once PTYs start spawning.
    if (sortBy === 'smart' && !sessionHasHadPty.current) {
      const hasAnyLivePty = Object.values(state.tabsByWorktree)
        .flat()
        .some((t) => t.ptyId)
      if (hasAnyLivePty) {
        sessionHasHadPty.current = true
      } else {
        nonArchivedWorktrees.sort(
          (a, b) => b.sortOrder - a.sortOrder || a.displayName.localeCompare(b.displayName)
        )
        return nonArchivedWorktrees.map((w) => w.id)
      }
    }

    const currentTabs = state.tabsByWorktree
    const now = Date.now()
    // Why precompute: this is the hot sidebar sort. Array.sort invokes the
    // comparator O(N log N) times, and the smart-score computation would
    // otherwise scan `agentStatusByPaneKey` (O(E)) or do per-worktree O(T)
    // index lookups on every call. Two layered optimizations:
    //   1. Build the tabId → explicit-entries index ONCE (O(E)) so the
    //      per-worktree scoring does cheap lookups instead of rescanning.
    //   2. Precompute scores once per worktree (decorate-sort-undecorate) so
    //      the comparator does O(1) map lookups instead of re-scoring per
    //      comparison.
    // Combined: O(E) index + O(N×T) scoring + O(N log N) sort, instead of
    // O(N × E × T) per sortEpoch bump. Only smart mode uses the score map;
    // other modes ignore it.
    const agentStatusForSort = AGENT_DASHBOARD_ENABLED ? state.agentStatusByPaneKey : undefined
    const explicitByTabId =
      sortBy === 'smart' ? buildExplicitEntriesByTabId(agentStatusForSort) : undefined
    const precomputedScores =
      sortBy === 'smart'
        ? new Map<string, number>(
            nonArchivedWorktrees.map((w) => [
              w.id,
              computeSmartScore(
                w,
                currentTabs,
                repoMap,
                state.prCache,
                now,
                agentStatusForSort,
                explicitByTabId
              )
            ])
          )
        : undefined
    nonArchivedWorktrees.sort(
      buildWorktreeComparator(
        sortBy,
        currentTabs,
        repoMap,
        state.prCache,
        now,
        null,
        agentStatusForSort,
        precomputedScores,
        explicitByTabId
      )
    )
    return nonArchivedWorktrees.map((w) => w.id)
    // debouncedSortEpoch is an intentional trigger: it's not read inside the
    // memo, but its change signals that the sort order should be recomputed.
    // The debounce prevents jarring mid-interaction position shifts.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSortEpoch, repoMap, sortBy])

  // Persist the computed sort order so the sidebar can be restored after
  // restart. Only persist during live sessions (sessionHasHadPty latched) —
  // on cold start we are *reading* the persisted order, not overwriting it.
  useEffect(() => {
    if (sortBy !== 'smart' || sortedIds.length === 0 || !sessionHasHadPty.current) {
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
    return ids.map((id) => worktreeMap.get(id)).filter((w): w is Worktree => w != null)
  }, [
    filterRepoIds,
    searchQuery,
    showActiveOnly,
    activeWorktreeId,
    repoMap,
    tabsByWorktree,
    browserTabsByWorktree,
    sortedIds,
    prCache,
    issueCache,
    worktreeMap,
    worktreesByRepo
  ])

  const worktrees = visibleWorktrees

  // Cmd+1–9 hint overlay: map worktree ID → hint number (1–9) for the first
  // 9 visible worktrees. Only populated while the user holds the modifier key.
  // Why suppress during modals: shortcuts like Cmd+J can open overlays via IPC
  // before the renderer observes the second key in the combo, which leaves the
  // bare-modifier timer armed. Hint badges are only useful while the sidebar is
  // the active navigation surface, so any modal should clear and disable them.
  const { showHints } = useModifierHint(activeModal === 'none')

  const collapsedGroups = useAppStore((s) => s.collapsedGroups)
  const toggleGroup = useAppStore((s) => s.toggleCollapsedGroup)

  // Build flat row list for rendering
  const rows: Row[] = useMemo(
    () => buildRows(groupBy, worktrees, repoMap, prCache, collapsedGroups),
    [groupBy, worktrees, repoMap, prCache, collapsedGroups]
  )
  // Why: rows.length alone can stay the same when items migrate between
  // groups (e.g., PR cache loads on restart and a collapsed group absorbs
  // an item while its header is added — net row count unchanged). Including
  // the header keys ensures the virtualizer remounts when group structure
  // changes, preventing stale height measurements from causing overlap.
  const viewportResetKey = useMemo(() => {
    const headers = rows
      .filter((r): r is GroupHeaderRow => r.type === 'header')
      .map((r) => r.key)
      .join(',')
    return `${groupBy}:${rows.length}:${headers}`
  }, [groupBy, rows])

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
  // Why: when the tasks page is active, no sidebar card should appear selected
  // — the user hasn't picked a worktree yet.
  const selectedSidebarWorktreeId = activeView === 'tasks' ? null : activeWorktreeId

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

  const handleCreateForRepo = useCallback(
    (repoId: string) => {
      openModal('new-workspace-composer', { initialRepoId: repoId })
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
      <div className="flex flex-col">
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
      </div>
    )
  }

  return (
    <VirtualizedWorktreeViewport
      key={viewportResetKey}
      rows={rows}
      activeWorktreeId={selectedSidebarWorktreeId}
      groupBy={groupBy}
      toggleGroup={toggleGroup}
      collapsedGroups={collapsedGroups}
      handleCreateForRepo={handleCreateForRepo}
      hintByWorktreeId={hintByWorktreeId}
      activeModal={activeModal}
      pendingRevealWorktreeId={pendingRevealWorktreeId}
      clearPendingRevealWorktreeId={clearPendingRevealWorktreeId}
      worktrees={worktrees}
      repoMap={repoMap}
      prCache={prCache}
    />
  )
})

export default WorktreeList
