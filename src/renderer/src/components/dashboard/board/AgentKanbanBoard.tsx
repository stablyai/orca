import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { XIcon } from 'lucide-react'
import {
  DASHBOARD_BUCKET_ORDER,
  type DashboardBucket,
  type DashboardCard,
  type DashboardSnapshot,
  type DashboardRevealAgentArgs as AgentRevealArgs
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import type { RepoIcon } from '../../../../../shared/repository/appearance/repo-icon'
import { cn } from '@/lib/class-names'
import { TooltipProvider } from '@/components/ui/tooltip'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { AgentKanbanLaneCardList } from './AgentKanbanLaneCardList'
import { AgentDashboardToolbar } from './AgentDashboardToolbar'
import { AgentTerminalDialog } from '../terminal-preview/AgentTerminalDialog'
import { EMPTY_DASHBOARD_FILTERS, type DashboardFilters } from './agent-board-filtering'
import './agent-board-transitions.css'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type { AgentSubjectReadIntent } from '@/attention/agent-subject-read-actions'
import { createDashboardBoardProjection, type DashboardLane } from './agent-board-projection'
import { dashboardCardIndex } from '../snapshot/dashboard-card-changes'

/** Relay acknowledgments to the main renderer; optional calls tolerate dev-HMR preload skew until restart. */
function ackAgentViaPopoutRelay(paneKey: string, intent: AgentSubjectReadIntent): void {
  void window.api.dashboard.ackAgent?.(paneKey, intent)
}

/** Reveal via main-window IPC; optional calls tolerate the same dev-HMR preload skew as acknowledgments. */
function revealAgentViaPopoutRelay(args: AgentRevealArgs): void {
  void window.api.dashboard.revealAgent?.(args)
}

function bucketLabel(bucket: DashboardBucket, t: Translate = translate): string {
  switch (bucket) {
    case 'attention':
      return t('dashboardPopout.bucket.attention', 'Needs You')
    case 'working':
      return t('dashboardPopout.bucket.working', 'Working')
    case 'done':
      return t('dashboardPopout.bucket.done', 'Done')
    case 'idle':
      return t('dashboardPopout.bucket.idle', 'Idle')
  }
}

/** Cards a host adds to Needs You below the agents' (bot items asking the owner). */
export type DashboardNeedsYouExtra = { count: number; content: React.ReactNode }

function KanbanColumn({
  bucket,
  cards,
  lane,
  repoIconsByRepoId,
  now,
  dialogPaneKey,
  onOpenTerminal,
  extra
}: {
  bucket: DashboardBucket
  cards: DashboardCard[]
  lane: DashboardLane
  repoIconsByRepoId: Record<string, RepoIcon | null> | undefined
  now: number
  dialogPaneKey: string | null
  onOpenTerminal: (card: DashboardCard) => void
  extra?: DashboardNeedsYouExtra
}): React.JSX.Element {
  const t = useTranslate()
  const label = bucketLabel(bucket, t)
  const extraCount = extra?.count ?? 0
  // State, not a ref: the list's virtualizer must re-render once the parent scroller attaches.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)

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
          {lane.indexes.length + extraCount}
        </span>
      </header>
      <div
        ref={setScrollElement}
        className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {lane.indexes.length === 0 && extraCount === 0 ? (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">
            {t('dashboardPopout.bucket.empty', 'None')}
          </p>
        ) : lane.indexes.length > 0 ? (
          <AgentKanbanLaneCardList
            cards={cards}
            lane={lane}
            scrollElement={scrollElement}
            repoIconsByRepoId={repoIconsByRepoId}
            now={now}
            dialogPaneKey={dialogPaneKey}
            onOpenTerminal={onOpenTerminal}
          />
        ) : null}
        {/* After the virtualized list, which measures its rows from the scroller's top. */}
        {extraCount > 0 ? extra?.content : null}
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
  onBrowserForeground?: () => void
  /** In-window settings controls; the pop-out renderer has no store to drive them. */
  headerActions?: React.ReactNode
  /** In-window reads the bots itself; the pop-out gets their items in its snapshot. */
  needsYouExtra?: DashboardNeedsYouExtra
}

/** Share snapshot-fed status columns across pop-out and in-window hosts with injected routing and sizing. */
export function AgentKanbanBoard({
  snapshot,
  containerClassName = 'h-screen w-screen',
  onAckAgent = ackAgentViaPopoutRelay,
  onRevealAgent = revealAgentViaPopoutRelay,
  onClose,
  onBrowserForeground,
  headerActions,
  needsYouExtra
}: AgentKanbanBoardProps): React.JSX.Element {
  const t = useTranslate()
  const visibleBuckets = useMemo(
    () =>
      DASHBOARD_BUCKET_ORDER.filter((bucket) => bucket !== 'idle' || snapshot.showIdle === true),
    [snapshot.showIdle]
  )
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [filters, setFilters] = useState<DashboardFilters>(EMPTY_DASHBOARD_FILTERS)
  const [projectBoard] = useState(createDashboardBoardProjection)
  const { lanes, visibleCards, hasRelativeTimestamps } = projectBoard(
    snapshot.cards,
    snapshot.showIdle === true,
    query,
    filters
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
      snapshot.cards[dashboardCardIndex(snapshot.cards, openedCard.paneKey)] ?? {
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
    <TooltipProvider>
      <div
        className={cn('relative flex flex-col bg-background text-foreground', containerClassName)}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <h1 className="text-[13px] font-semibold">{t('dashboardPopout.title', 'Agents')}</h1>
          <span className="text-[11px] text-muted-foreground">
            {t('dashboardPopout.total', '{{count}} total', {
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
                  aria-label={t('dashboardPopout.close', 'Close dashboard')}
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
          filteredCount={visibleBuckets.reduce(
            (count, bucket) => count + lanes[bucket].indexes.length,
            0
          )}
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
                cards={snapshot.cards}
                lane={lanes[bucket]}
                repoIconsByRepoId={snapshot.repoIconsByRepoId}
                now={now}
                dialogPaneKey={openedCard?.paneKey ?? null}
                onOpenTerminal={handleOpenTerminal}
                extra={bucket === 'attention' ? needsYouExtra : undefined}
              />
            ))}
          </div>
        </div>
        <AgentTerminalDialog
          card={dialogCard}
          onOpenChange={handleDialogOpenChange}
          onReveal={onRevealAgent}
          onBrowserForeground={onBrowserForeground}
        />
      </div>
    </TooltipProvider>
  )
}
