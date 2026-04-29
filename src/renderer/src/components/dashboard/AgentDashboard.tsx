import React, { useState, useCallback, useMemo, useRef } from 'react'
import { Search, X, ChevronDown, ChevronRight, FolderGit2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useDashboardData } from './useDashboardData'
import { useDashboardFilter } from './useDashboardFilter'
import { useDashboardKeyboard } from './useDashboardKeyboard'
import { useRetainedAgents } from './useRetainedAgents'
import DashboardFilterBar from './DashboardFilterBar'
import DashboardWorktreeCard from './DashboardWorktreeCard'
import { useNow } from './useNow'

const AgentDashboard = React.memo(function AgentDashboard() {
  const liveGroups = useDashboardData()
  // Why: useRetainedAgents keeps a "done" row visible after the terminal/pane
  // is closed and the explicit status entry is evicted from the store. Without
  // this, a completed agent vanishes entirely — and the user loses the signal
  // that the agent finished. Retained rows are dismissed when the user clicks
  // through to the worktree.
  const { enrichedGroups: groups, dismissAgent } = useRetainedAgents(liveGroups)
  const dropAgentStatus = useAppStore((s) => s.dropAgentStatus)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const setActiveView = useAppStore((s) => s.setActiveView)
  // Why: the persistent "selected" tint on a worktree card tracks the active
  // worktree, not the last-clicked focus state. Keeping this in sync with the
  // app-level activeWorktreeId makes the dashboard highlight what the user is
  // currently viewing rather than where the keyboard/mouse last landed.
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  // Why: own the 30s relative-time tick once for the whole dashboard and
  // thread it down to every agent row. Previously each DashboardAgentRow
  // instantiated its own setInterval, which scaled linearly with the number
  // of rows on screen (N timers → N staggered re-renders per cycle).
  const now = useNow(30_000)

  // Why: the store's explicit status entry persists after an agent reports
  // `done` until the pane actually exits — which may be much later, since the
  // user often leaves the Claude/Codex session alive to review output. The
  // per-row dismiss removes both the live store entry and any retained entry
  // so done agents don't pile up indefinitely in the dashboard.
  const handleDismissAgent = useCallback(
    (paneKey: string) => {
      dropAgentStatus(paneKey)
      dismissAgent(paneKey)
    },
    [dropAgentStatus, dismissAgent]
  )

  const [searchQuery, setSearchQuery] = useState('')
  const { filter, setFilter, filteredGroups, hasResults } = useDashboardFilter(groups, searchQuery)
  const [focusedWorktreeId, setFocusedWorktreeId] = useState<string | null>(null)
  // Why: repo groups are collapsible so users can hide repos they aren't
  // actively watching. State is per-session (intentionally not persisted) —
  // a long-lived collapsed state across restarts would hide new activity
  // under a closed header and silently erase the "needs attention" signal.
  const [collapsedRepos, setCollapsedRepos] = useState<Set<string>>(new Set())
  const toggleCollapse = useCallback((repoId: string) => {
    setCollapsedRepos((prev) => {
      const next = new Set(prev)
      if (next.has(repoId)) {
        next.delete(repoId)
      } else {
        next.add(repoId)
      }
      return next
    })
  }, [])
  // Why: arrow-key nav should only step over worktrees whose repo header is
  // expanded. Building this list here keeps the source of truth in one place
  // for both the DOM render order and the keyboard iteration order.
  const visibleWorktrees = useMemo(
    () => filteredGroups.flatMap((g) => (collapsedRepos.has(g.repo.id) ? [] : g.worktrees)),
    [filteredGroups, collapsedRepos]
  )

  // Why: the keyboard hook scopes its listener to this container (not window)
  // so dashboard shortcuts (1-5, arrows, Enter, Escape) don't hijack the
  // terminal or other focused inputs when the dashboard pane is merely open.
  // We keep a local ref so the callback ref below can detect the null → element
  // transition (for focus-on-first-mount), and separately feed the element into
  // `useDashboardKeyboard` via its callback ref. The container is rendered
  // unconditionally (including on the no-repos empty state) so keyboard
  // shortcuts remain wired even before any repo is added — otherwise the
  // filter keys (1-5) would silently no-op until the first repo arrived.
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Why: clicking an agent row takes the user to the specific tab the agent
  // ran in, not just the worktree's last-active tab. Retained rows can outlive
  // their pane — fall back to worktree-only activation when the tab is no
  // longer present so the click still lands somewhere useful.
  const handleActivateAgentTab = useCallback(
    (worktreeId: string, tabId: string) => {
      setActiveWorktree(worktreeId)
      setActiveView('terminal')
      const tabs = useAppStore.getState().tabsByWorktree[worktreeId] ?? []
      if (tabs.some((t) => t.id === tabId)) {
        setActiveTab(tabId)
      }
    },
    [setActiveWorktree, setActiveTab, setActiveView]
  )

  // Why: a stable reference shared across every DashboardWorktreeCard so
  // React.memo can actually short-circuit re-renders. An inline
  // `() => setFocusedWorktreeId(card.worktree.id)` per card per render would
  // mint a fresh function every render and invalidate memo on all N cards
  // even when nothing else changed — the 30s `now` tick alone would cascade.
  const handleCardFocus = useCallback((worktreeId: string) => setFocusedWorktreeId(worktreeId), [])

  const setKeyboardContainer = useDashboardKeyboard({
    filteredWorktrees: visibleWorktrees,
    focusedWorktreeId,
    setFocusedWorktreeId,
    filter,
    setFilter
  })

  // Why: combine the local RefObject with the keyboard hook's callback ref so
  // both see the same element on attach/detach, and use the callback to drive
  // focus-on-first-mount (below). A callback ref is the canonical React
  // pattern for "run code when an element mounts/unmounts" and is required
  // here because the container div is conditionally rendered — a RefObject
  // alone wouldn't notify the keyboard hook (or the focus logic) when the
  // container appears after the empty-state branch is replaced.
  const setContainerRef = useCallback(
    (el: HTMLDivElement | null) => {
      const hadEl = containerRef.current !== null
      containerRef.current = el
      setKeyboardContainer(el)
      // Why: focus the container the first time it becomes non-null so keyboard
      // shortcuts work immediately — including on the path where the empty-state
      // branch renders first (no container) and repos arrive later. A []-deps
      // useEffect would fire once against a null ref on that path and never
      // re-run. activeElement guard prevents stealing focus from inputs the
      // user is currently typing in (e.g. sidebar search, terminal).
      if (el && !hadEl) {
        if (document.activeElement === null || document.activeElement === document.body) {
          el.focus()
        }
      }
    },
    [setKeyboardContainer]
  )

  const handleClearSearch = useCallback(() => setSearchQuery(''), [])

  const searchActive = searchQuery.trim().length > 0
  const showNoResults = searchActive && !hasResults
  // Why: render the container unconditionally so the keyboard hook's
  // callback ref fires on mount even when no repos exist yet — otherwise
  // filter/arrow shortcuts don't bind until the first repo arrives.
  const hasRepos = groups.length > 0

  return (
    <div
      ref={setContainerRef}
      tabIndex={-1}
      className="flex h-full w-full flex-col overflow-hidden outline-none"
    >
      {!hasRepos ? (
        <div className="flex h-full w-full items-center justify-center p-4">
          <div className="text-center text-[11px] text-muted-foreground">
            No repos added. Add a repo to see agent activity.
          </div>
        </div>
      ) : (
        <>
          <div className="flex shrink-0 flex-col gap-1.5 border-b border-border/40 px-2 py-1.5">
            <div className="relative flex items-center">
              <Search className="absolute left-2 size-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search..."
                className="h-7 pl-7 pr-7 text-[11px] border-none bg-muted/50 shadow-none focus-visible:ring-1 focus-visible:ring-ring/30"
              />
              {searchActive && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={handleClearSearch}
                  className="absolute right-1 size-5"
                  aria-label="Clear search"
                >
                  <X className="size-3" />
                </Button>
              )}
            </div>
            <div className="flex items-center justify-center">
              <DashboardFilterBar value={filter} onChange={setFilter} />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto scrollbar-sleek">
            {hasResults ? (
              <div className="flex flex-col">
                {filteredGroups.map((group, groupIdx) => {
                  const isCollapsed = collapsedRepos.has(group.repo.id)
                  // Why: per-repo stats replace the global stats strip that used
                  // to sit above the whole dashboard. Counts live at the scope
                  // of the grouping so the user sees per-repo agent load instead
                  // of a rollup that hides which repo is busy. Counts come from
                  // useDashboardFilter's memo so this doesn't re-walk every agent
                  // in every worktree on each `now` tick or search change.
                  const { running: groupRunning, blocked: groupBlocked, done: groupDone } = group
                  const Icon = isCollapsed ? ChevronRight : ChevronDown
                  return (
                    <div
                      key={group.repo.id}
                      // Why: the entire repo group tints on hover (children and
                      // all) so the user sees a clear visual container for the
                      // repo — mirroring the worktree → agent pattern where the
                      // whole worktree tints when hovered and its nested agent
                      // rows tint more strongly on top. No card chrome, just an
                      // ambient hover.
                      className={cn(
                        // Why: light-mode needs to darken the surface (not add
                        // a pale accent to near-white) for the container tint
                        // to register. Use a subtle black alpha in light, keep
                        // the original alpha-on-accent in dark (which already
                        // reads as a faint lift on the dark surface).
                        'transition-colors duration-100 hover:bg-black/[0.02] dark:hover:bg-accent/10',
                        groupIdx !== filteredGroups.length - 1 && 'border-b border-border'
                      )}
                    >
                      {/* Why: the repo header is a lightweight row, not a card —
                      no background fill, no border box. It stays an
                      expand/collapse control so users can hide repos they
                      aren't watching, but it doesn't wrap the children in
                      chrome that duplicates the worktree row's own borders. */}
                      <button
                        type="button"
                        onClick={() => toggleCollapse(group.repo.id)}
                        className={cn(
                          'flex w-full items-center gap-1.5 px-2.5 pt-1.5 pb-1',
                          'text-left text-[11px] text-muted-foreground/80'
                        )}
                        aria-expanded={!isCollapsed}
                      >
                        <Icon className="size-3 shrink-0 text-muted-foreground/60" />
                        {/* Why: mirror the sidebar's worktree list — repos are
                        keyed by the FolderGit2 glyph colored with the repo's
                        own badgeColor, so the dashboard header reads as the
                        same repo entity a user scans for in the sidebar. */}
                        <FolderGit2
                          className="size-3 shrink-0"
                          style={{ color: group.repo.badgeColor }}
                          aria-hidden
                        />
                        <span className="truncate font-medium text-foreground/80">
                          {group.repo.displayName}
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
                          {groupRunning > 0 && (
                            <span>
                              <span className="font-semibold text-yellow-500">{groupRunning}</span>{' '}
                              active
                            </span>
                          )}
                          {groupBlocked > 0 && (
                            <span>
                              <span className="font-semibold text-red-500">{groupBlocked}</span>{' '}
                              blocked
                            </span>
                          )}
                          {groupDone > 0 && (
                            <span>
                              <span className="font-semibold text-emerald-500">{groupDone}</span>{' '}
                              done
                            </span>
                          )}
                        </span>
                      </button>
                      {!isCollapsed &&
                        group.worktrees.map((card, i) => (
                          <DashboardWorktreeCard
                            key={card.worktree.id}
                            card={card}
                            isActive={activeWorktreeId === card.worktree.id}
                            onFocus={handleCardFocus}
                            onDismissAgent={handleDismissAgent}
                            onActivateAgentTab={handleActivateAgentTab}
                            isLast={i === group.worktrees.length - 1}
                            now={now}
                          />
                        ))}
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="flex flex-col items-center pt-4 pb-6 gap-2">
                <div className="text-[11px] text-muted-foreground/60">
                  {showNoResults
                    ? 'No matches.'
                    : filter === 'active'
                      ? 'No active agents.'
                      : filter === 'blocked'
                        ? 'No agents are blocked.'
                        : filter === 'done'
                          ? 'No completed agents to show.'
                          : 'No agent activity yet.'}
                </div>
                {showNoResults ? (
                  <button
                    type="button"
                    onClick={handleClearSearch}
                    className="text-[11px] text-primary/70 hover:text-primary hover:underline"
                  >
                    Clear search
                  </button>
                ) : (
                  filter !== 'all' && (
                    <button
                      type="button"
                      onClick={() => setFilter('all')}
                      className="text-[11px] text-primary/70 hover:text-primary hover:underline"
                    >
                      Show all
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
})

export default AgentDashboard
