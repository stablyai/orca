import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { XIcon } from 'lucide-react'
import {
  DASHBOARD_BUCKET_ORDER,
  type DashboardBucket,
  type DashboardCard,
  type DashboardSnapshot
} from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import { cn } from '@/lib/utils'
import { TooltipProvider } from '@/components/ui/tooltip'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { AgentKanbanCard } from './AgentKanbanCard'
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

/** Relay acknowledgments to the main renderer; optional calls tolerate dev-HMR preload skew until restart. */
function ackAgentViaPopoutRelay(paneKey: string, intent: AgentSubjectReadIntent): void {
  void window.api.dashboard.ackAgent?.(paneKey, intent)
}

/** Reveal via main-window IPC; optional calls tolerate the same dev-HMR preload skew as acknowledgments. */
function revealAgentViaPopoutRelay(args: AgentRevealArgs): void {
  void window.api.dashboard.revealAgent?.(args)
}

function bucketLabel(bucket: DashboardBucket): string {
  switch (bucket) {
    case 'attention':
      return translate('dashboardPopout.bucket.attention', 'Needs You')
    case 'working':
      return translate('dashboardPopout.bucket.working', 'Working')
    case 'done':
      return translate('dashboardPopout.bucket.done', 'Done')
    case 'idle':
      return translate('dashboardPopout.bucket.idle', 'Idle')
  }
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
  // Newly moved cards lead their column, matching the view-transition motion.
  for (const bucket of DASHBOARD_BUCKET_ORDER) {
    grouped[bucket].sort((a, b) => b.stateChangedAt - a.stateChangedAt)
  }
  return grouped
}

function KanbanColumn({
  bucket,
  cards,
  repoIconsByRepoId,
  now,
  onOpenTerminal
}: {
  bucket: DashboardBucket
  cards: DashboardCard[]
  repoIconsByRepoId: Record<string, RepoIcon | null> | undefined
  now: number
  onOpenTerminal: (card: DashboardCard) => void
}): React.JSX.Element {
  const label = bucketLabel(bucket)

  return (
    // Cards carry attention color; keep the column neutral to avoid duplicate signaling.
    <section
      aria-label={label}
      className="flex min-w-[264px] flex-1 flex-col rounded-xl border border-border/60 bg-muted/30"
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {label}
        </span>
        <span className="ml-auto rounded-full bg-background px-1.5 text-[11px] tabular-nums text-muted-foreground">
          {cards.length}
        </span>
      </header>
      <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {cards.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">
            {translate('dashboardPopout.bucket.empty', 'None')}
          </p>
        ) : (
          cards.map((card) => (
            <AgentKanbanCard
              key={card.paneKey}
              card={card}
              repoIcon={repoIconsByRepoId?.[card.repoId] ?? null}
              now={now}
              onOpenTerminal={onOpenTerminal}
            />
          ))
        )}
      </div>
    </section>
  )
}

type AgentKanbanBoardProps = {
  snapshot: DashboardSnapshot
  /** Fill the pop-out window or the in-window drawer’s host. */
  containerClassName?: string
  /** Default to the pop-out IPC relay; in-window hosts acknowledge directly in the store. */
  onAckAgent?: (paneKey: string, intent: AgentSubjectReadIntent) => void
  /** Default to the pop-out IPC relay; in-window hosts activate locally and close their overlay. */
  onRevealAgent?: (args: AgentRevealArgs) => void
  /** In-window hosts provide a close control; pop-outs use native window controls. */
  onClose?: () => void
  /** In-window settings controls; the pop-out renderer has no store to drive them. */
  headerActions?: React.ReactNode
}

/** Share snapshot-fed status columns across pop-out and in-window hosts with injected routing and sizing. */
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

  // Resolve open dialogs by paneKey across bucket moves; retain vanished cards until dismissal but clear routing because PTY IDs can be reused.
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

  // Relay read acknowledgments through the shared app-wide map; the next snapshot clears unseen.
  const clickAcked = useRef<{ paneKey: string; stateChangedAt: number } | null>(null)
  const handleOpenTerminal = useCallback(
    (card: DashboardCard) => {
      onAckAgent(card.paneKey, 'explicit')
      clickAcked.current = { paneKey: card.paneKey, stateChangedAt: card.stateChangedAt }
      setOpenedCard(card)
    },
    [onAckAgent]
  )
  // Acknowledge state changes while watched so open-dialog cards do not become unseen again.
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
    // Pop-outs have no app provider; supply the card tooltip provider in either host.
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
              <KanbanColumn
                key={bucket}
                bucket={bucket}
                cards={grouped[bucket]}
                repoIconsByRepoId={snapshot.repoIconsByRepoId}
                now={now}
                onOpenTerminal={handleOpenTerminal}
              />
            ))}
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
