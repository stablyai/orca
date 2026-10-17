import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { XIcon } from 'lucide-react'
import type { DashboardCard, DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import {
  DASHBOARD_MAX_CUSTOM_LANES,
  type DashboardLaneAction
} from '../../../../shared/dashboard-lanes'
import { cn } from '@/lib/utils'
import { TooltipProvider } from '@/components/ui/tooltip'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { AgentKanbanColumn } from './AgentKanbanColumn'
import { AgentKanbanAddLane } from './AgentKanbanAddLane'
import {
  agentBoardColumnKeyForCard,
  buildAgentBoardColumns,
  groupCardsByColumn,
  prunePendingPlacements,
  type AgentBoardColumn,
  type AgentBoardPendingPlacements
} from './agent-board-columns'
import { AgentDashboardToolbar } from './AgentDashboardToolbar'
import { AgentTerminalDialog, type AgentRevealArgs } from './AgentTerminalDialog'
import {
  EMPTY_DASHBOARD_FILTERS,
  filterDashboardCards,
  type DashboardFilters
} from './agent-board-filtering'
import './agent-board-transitions.css'
import { translate } from '@/i18n/i18n'
import type { AgentSubjectReadIntent } from '@/attention/agent-subject-read-actions'

/** Ack an agent in the pop-out window: relayed over IPC to the main renderer.
 *  ?. shields dialog-opening from dev-HMR preload skew (renderer updates hot,
 *  the preload only on app restart) — acks just no-op until restart. */
function ackAgentViaPopoutRelay(paneKey: string, intent: AgentSubjectReadIntent): void {
  void window.api.dashboard.ackAgent?.(paneKey, intent)
}

/** Reveal an agent from the pop-out window: raise the main window and route it
 *  to the agent's pane via IPC. Same `?.` HMR-skew guard as the ack relay —
 *  both channels ship together, so a stale preload lacks both. */
function revealAgentViaPopoutRelay(args: AgentRevealArgs): void {
  void window.api.dashboard.revealAgent?.(args)
}

/** Lane edits from the pop-out: the main renderer owns settings. */
function laneActionViaPopoutRelay(action: DashboardLaneAction): void {
  void window.api.dashboard.laneAction?.(action)
}

type AgentKanbanBoardProps = {
  snapshot: DashboardSnapshot
  /** Sizing for the outermost container. The pop-out fills the window
   *  (h-screen w-screen); the in-window drawer fills its host (h-full w-full). */
  containerClassName?: string
  /** Marks an agent as seen. Defaults to the pop-out IPC relay; the in-window
   *  host acks the store directly. */
  onAckAgent?: (paneKey: string, intent: AgentSubjectReadIntent) => void
  /** Focuses the agent's pane. Defaults to the pop-out IPC relay; the in-window
   *  host activates the worktree/pane locally and closes the overlay. */
  onRevealAgent?: (args: AgentRevealArgs) => void
  /** Adds/renames/removes custom lanes and parks cards in them. Defaults to
   *  the pop-out IPC relay; the in-window host writes settings directly. */
  onLaneAction?: (action: DashboardLaneAction) => void
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
  onLaneAction = laneActionViaPopoutRelay,
  onClose,
  headerActions
}: AgentKanbanBoardProps): React.JSX.Element {
  const customLanes = useMemo(() => snapshot.customLanes ?? [], [snapshot.customLanes])
  const columns = useMemo(
    () => buildAgentBoardColumns(snapshot.showIdle === true, customLanes),
    [snapshot.showIdle, customLanes]
  )
  const laneIds = useMemo(() => new Set(customLanes.map((lane) => lane.id)), [customLanes])
  // Why: a drop round-trips through settings and the next snapshot; holding it
  // locally keeps the card from snapping back for a frame.
  const [pending, setPending] = useState<AgentBoardPendingPlacements>({})
  const [prunedFor, setPrunedFor] = useState(snapshot)
  if (prunedFor !== snapshot) {
    setPrunedFor(snapshot)
    setPending(prunePendingPlacements(pending, snapshot.cards, laneIds))
  }
  const columnKeys = useMemo(() => new Set(columns.map((column) => column.key)), [columns])
  const visibleCards = useMemo(
    () =>
      snapshot.cards.filter((card) =>
        columnKeys.has(agentBoardColumnKeyForCard(card, laneIds, pending))
      ),
    [snapshot.cards, columnKeys, laneIds, pending]
  )
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [filters, setFilters] = useState<DashboardFilters>(EMPTY_DASHBOARD_FILTERS)
  const filteredCards = useMemo(
    () => filterDashboardCards(visibleCards, query, filters),
    [visibleCards, filters, query]
  )
  const grouped = useMemo(
    () => groupCardsByColumn(filteredCards, columns, pending),
    [filteredCards, columns, pending]
  )
  const [draggingCard, setDraggingCard] = useState<DashboardCard | null>(null)
  const handleCardDragEnd = useCallback(() => setDraggingCard(null), [])
  const handleDropCard = useCallback(
    (column: AgentBoardColumn) => {
      if (!draggingCard) {
        return
      }
      const laneId = column.kind === 'lane' ? column.lane.id : null
      setPending((previous) => ({ ...previous, [draggingCard.paneKey]: laneId }))
      onLaneAction({ kind: 'place', paneKey: draggingCard.paneKey, laneId })
      setDraggingCard(null)
    },
    [draggingCard, onLaneAction]
  )
  // Status columns only accept a parked card (unparking it); its own status
  // column is the one it returns to, so any of them reads as "back to auto".
  const canDropOn = (column: AgentBoardColumn): boolean => {
    if (!draggingCard) {
      return false
    }
    const currentKey = agentBoardColumnKeyForCard(draggingCard, laneIds, pending)
    if (column.key === currentKey) {
      return false
    }
    return column.kind === 'lane' || currentKey.startsWith('lane:')
  }
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
  const clickAcked = useRef<{ paneKey: string; stateChangedAt: number } | null>(null)
  const handleOpenTerminal = useCallback(
    (card: DashboardCard) => {
      onAckAgent(card.paneKey, 'explicit')
      clickAcked.current = { paneKey: card.paneKey, stateChangedAt: card.stateChangedAt }
      setOpenedCard(card)
    },
    [onAckAgent]
  )
  // Watching the open dialog counts as seeing state changes as they happen —
  // without this, an agent finishing while you watch would re-flag its card.
  useEffect(() => {
    // The click already read the state it opened on; only later changes are watched.
    const clicked = clickAcked.current
    if (
      dialogCard?.unseen &&
      !(
        clicked?.paneKey === dialogCard.paneKey &&
        clicked.stateChangedAt === dialogCard.stateChangedAt
      )
    ) {
      onAckAgent(dialogCard.paneKey, 'view')
    }
  }, [dialogCard?.paneKey, dialogCard?.unseen, dialogCard?.stateChangedAt, onAckAgent])

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
            {columns.map((column) => (
              <AgentKanbanColumn
                key={column.key}
                column={column}
                cards={grouped.get(column.key) ?? []}
                repoIconsByRepoId={snapshot.repoIconsByRepoId}
                now={now}
                onOpenTerminal={handleOpenTerminal}
                canDrop={canDropOn(column)}
                onCardDragStart={setDraggingCard}
                onCardDragEnd={handleCardDragEnd}
                onDropCard={handleDropCard}
                onRenameLane={(laneId, label) => onLaneAction({ kind: 'rename', laneId, label })}
                onRemoveLane={(laneId) => onLaneAction({ kind: 'remove', laneId })}
              />
            ))}
            {customLanes.length < DASHBOARD_MAX_CUSTOM_LANES ? (
              <AgentKanbanAddLane onAddLane={(label) => onLaneAction({ kind: 'add', label })} />
            ) : null}
          </div>
        </div>
        <AgentTerminalDialog
          card={dialogCard}
          onOpenChange={handleDialogOpenChange}
          onReveal={onRevealAgent}
        />
      </div>
    </TooltipProvider>
  )
}
