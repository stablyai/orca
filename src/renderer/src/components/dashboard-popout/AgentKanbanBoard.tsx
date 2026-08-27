import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { XIcon } from 'lucide-react'
import {
  DASHBOARD_BUCKET_ORDER,
  type DashboardBucket,
  type DashboardCard,
  type DashboardSnapshot
} from '../../../../shared/dashboard-snapshot'
import { cn } from '@/lib/utils'
import { TooltipProvider } from '@/components/ui/tooltip'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { AgentKanbanColumn } from './AgentKanbanColumn'
import { AgentDashboardToolbar } from './AgentDashboardToolbar'
import { stopNeedsDialog } from './AgentKanbanCardStopControl'
import { AgentStopConfirmDialog } from './AgentStopConfirmDialog'
import { AgentTerminalDialog, type AgentRevealArgs } from './AgentTerminalDialog'
import {
  EMPTY_DASHBOARD_FILTERS,
  filterDashboardCards,
  type DashboardFilters
} from './agent-board-filtering'
import './agent-board-transitions.css'
import { translate } from '@/i18n/i18n'

/** Ack an agent in the pop-out window: relayed over IPC to the main renderer.
 *  ?. shields dialog-opening from dev-HMR preload skew (renderer updates hot,
 *  the preload only on app restart) — acks just no-op until restart. */
function ackAgentViaPopoutRelay(paneKey: string): void {
  void window.api.dashboard.ackAgent?.(paneKey)
}

/** Reveal an agent from the pop-out window: raise the main window and route it
 *  to the agent's pane via IPC. Same `?.` HMR-skew guard as the ack relay —
 *  both channels ship together, so a stale preload lacks both. */
function revealAgentViaPopoutRelay(args: AgentRevealArgs): void {
  void window.api.dashboard.revealAgent?.(args)
}

function groupByBucket(cards: DashboardCard[]): Record<DashboardBucket, DashboardCard[]> {
  const grouped: Record<DashboardBucket, DashboardCard[]> = {
    attention: [],
    working: [],
    done: [],
    idle: []
  }
  for (const card of cards) {
    grouped[card.bucket].push(card)
  }
  // Most-recently-moved first: a card entering a column lands at the top,
  // matching the view-transition motion the user just watched.
  for (const bucket of DASHBOARD_BUCKET_ORDER) {
    grouped[bucket].sort((a, b) => b.stateChangedAt - a.stateChangedAt)
  }
  return grouped
}

type AgentKanbanBoardProps = {
  snapshot: DashboardSnapshot
  /** Sizing for the outermost container. The pop-out fills the window
   *  (h-screen w-screen); the in-window drawer fills its host (h-full w-full). */
  containerClassName?: string
  /** Marks an agent as seen. Defaults to the pop-out IPC relay; the in-window
   *  host acks the store directly. */
  onAckAgent?: (paneKey: string) => void
  /** Focuses the agent's pane. Defaults to the pop-out IPC relay; the in-window
   *  host activates the worktree/pane locally and closes the overlay. */
  onRevealAgent?: (args: AgentRevealArgs) => void
  /** When provided, renders a close control in the header (in-window mode). The
   *  pop-out relies on its native window controls, so it omits this. */
  onClose?: () => void
  /** Header controls rendered before the close button. The in-window host
   *  passes its settings menu; the pop-out renderer has no store to drive it. */
  headerActions?: React.ReactNode
}

/** The agent board: status columns fed by a snapshot. Shared by the pop-out
 *  window and the in-window drawer — the two differ only in sizing and
 *  how ack/reveal are routed. */
export function AgentKanbanBoard({
  snapshot,
  containerClassName = 'h-screen w-screen',
  onAckAgent = ackAgentViaPopoutRelay,
  onRevealAgent = revealAgentViaPopoutRelay,
  onClose,
  headerActions
}: AgentKanbanBoardProps): React.JSX.Element {
  const visibleBuckets = useMemo(
    () =>
      DASHBOARD_BUCKET_ORDER.filter((bucket) => bucket !== 'idle' || snapshot.showIdle === true),
    [snapshot.showIdle]
  )
  const visibleCards = useMemo(
    () => snapshot.cards.filter((card) => visibleBuckets.includes(card.bucket)),
    [snapshot.cards, visibleBuckets]
  )
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [filters, setFilters] = useState<DashboardFilters>(EMPTY_DASHBOARD_FILTERS)
  const filteredCards = useMemo(
    () => filterDashboardCards(visibleCards, query, filters),
    [visibleCards, filters, query]
  )
  const grouped = useMemo(() => groupByBucket(filteredCards), [filteredCards])
  const hasRelativeTimestamps = useMemo(
    () => snapshot.cards.some((card) => (card.finishedAt ?? card.startedAt) > 0),
    [snapshot.cards]
  )
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!hasRelativeTimestamps) {
      return
    }
    return installWindowVisibilityInterval({
      run: () => setNow(Date.now()),
      intervalMs: 30_000
    })
  }, [hasRelativeTimestamps])

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent): void => {
      const usesPlatformModifier = navigator.userAgent.includes('Mac')
        ? event.metaKey
        : event.ctrlKey
      if (!usesPlatformModifier || event.key.toLowerCase() !== 'k') {
        return
      }
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, [contenteditable="true"], .xterm')
      ) {
        return
      }
      event.preventDefault()
      searchInputRef.current?.focus()
    }
    document.addEventListener('keydown', handleSearchShortcut)
    return () => document.removeEventListener('keydown', handleSearchShortcut)
  }, [])

  // The open terminal dialog survives bucket moves: only the paneKey is
  // remembered, and the card data is re-resolved from each fresh snapshot.
  // The opened card is kept as a fallback so the dialog also survives the
  // card vanishing entirely (pane closed) — the user dismisses it explicitly.
  // Its live routing is cleared because daemon PTY ids can be reused.
  const [openedCard, setOpenedCard] = useState<DashboardCard | null>(null)
  const dialogCard = useMemo(() => {
    if (!openedCard) {
      return null
    }
    return (
      snapshot.cards.find((c) => c.paneKey === openedCard.paneKey) ?? {
        ...openedCard,
        ptyId: null,
        leafId: null
      }
    )
  }, [snapshot.cards, openedCard])
  const handleDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setOpenedCard(null)
    }
  }, [])

  // Seen-state is the app-wide ack map (same signal as the sidebar's bold/mute
  // rows): opening a dialog acks the agent, and the next snapshot comes back
  // with unseen=false.
  const handleOpenTerminal = useCallback(
    (card: DashboardCard) => {
      onAckAgent(card.paneKey)
      setOpenedCard(card)
    },
    [onAckAgent]
  )

  // Stopping kills the agent's process in the main renderer, which owns the
  // store and the terminal teardown. Still-running agents confirm through a
  // dialog first; idle/done ones already confirmed inline on their card.
  const [pendingStopPaneKey, setPendingStopPaneKey] = useState<string | null>(null)
  const resolvedPendingStopCard = useMemo(() => {
    if (!pendingStopPaneKey) {
      return null
    }
    return snapshot.cards.find((card) => card.paneKey === pendingStopPaneKey) ?? null
  }, [pendingStopPaneKey, snapshot.cards])
  // ?. shields this from dev-HMR preload skew, same as the ack relay above.
  const emitStop = useCallback((card: DashboardCard) => {
    void window.api.dashboard.stopAgent?.({
      paneKey: card.paneKey,
      worktreeId: card.worktreeId,
      tabId: card.tabId,
      leafId: card.leafId,
      ptyId: card.ptyId
    })
  }, [])
  const handleStop = useCallback(
    (card: DashboardCard) => {
      if (stopNeedsDialog(card)) {
        setPendingStopPaneKey(card.paneKey)
        return
      }
      emitStop(card)
    },
    [emitStop]
  )
  const handleConfirmStop = useCallback(() => {
    setPendingStopPaneKey(null)
    if (resolvedPendingStopCard) {
      emitStop(resolvedPendingStopCard)
    }
  }, [emitStop, resolvedPendingStopCard])
  const handleCancelStop = useCallback(() => setPendingStopPaneKey(null), [])

  // Watching the open dialog counts as seeing state changes as they happen —
  // without this, an agent finishing while you watch would re-flag its card.
  useEffect(() => {
    if (dialogCard?.unseen) {
      onAckAgent(dialogCard.paneKey)
    }
  }, [dialogCard?.paneKey, dialogCard?.unseen, onAckAgent])

  return (
    // Why: the pop-out is its own React root with no app-level provider, and the
    // card's repo tooltip needs one in both hosts. Nesting inside the main
    // window's provider is harmless.
    <TooltipProvider delayDuration={300}>
      <div
        className={cn('relative flex flex-col bg-background text-foreground', containerClassName)}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <h1 className="text-[13px] font-semibold">
            {translate('dashboardPopout.title', 'Agents')}
          </h1>
          <span className="text-[11px] text-muted-foreground">
            {translate('dashboardPopout.total', '{{count}} total', {
              count: visibleCards.length
            })}
          </span>
          {headerActions || onClose ? (
            <div className="ml-auto flex items-center gap-1">
              {headerActions}
              {onClose ? (
                <button
                  type="button"
                  onClick={onClose}
                  aria-label={translate('dashboardPopout.close', 'Close dashboard')}
                  className="rounded-sm p-1 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <XIcon className="size-4" />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <AgentDashboardToolbar
          cards={visibleCards}
          filterOptions={snapshot.filterOptions}
          filteredCount={filteredCards.length}
          query={query}
          onQueryChange={setQuery}
          filters={filters}
          onFiltersChange={setFilters}
          searchInputRef={searchInputRef}
        />
        <div className="scrollbar-sleek flex min-h-0 flex-1 overflow-x-auto p-3">
          {/* Auto margins center the capped board and collapse during horizontal overflow. */}
          <div className="mx-auto flex w-full max-w-[1280px] gap-3">
            {visibleBuckets.map((bucket) => (
              <AgentKanbanColumn
                key={bucket}
                bucket={bucket}
                cards={grouped[bucket]}
                repoIconsByRepoId={snapshot.repoIconsByRepoId}
                now={now}
                onOpenTerminal={handleOpenTerminal}
                onStop={handleStop}
              />
            ))}
          </div>
        </div>
        <AgentTerminalDialog
          card={dialogCard}
          onOpenChange={handleDialogOpenChange}
          onReveal={onRevealAgent}
        />
        <AgentStopConfirmDialog
          card={resolvedPendingStopCard}
          onCancel={handleCancelStop}
          onConfirm={handleConfirmStop}
        />
      </div>
    </TooltipProvider>
  )
}
