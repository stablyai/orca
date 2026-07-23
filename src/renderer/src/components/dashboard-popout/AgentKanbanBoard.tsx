import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DASHBOARD_BUCKET_ORDER,
  type DashboardBucket,
  type DashboardCard,
  type DashboardSnapshot
} from '../../../../shared/dashboard-snapshot'
import { cn } from '@/lib/utils'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { AgentKanbanCard } from './AgentKanbanCard'
import { AgentTerminalDialog } from './AgentTerminalDialog'
import './agent-board-transitions.css'
import { translate } from '@/i18n/i18n'

function bucketLabel(bucket: DashboardBucket): string {
  switch (bucket) {
    case 'attention':
      return translate('dashboardPopout.bucket.attention', 'Needs You')
    case 'working':
      return translate('dashboardPopout.bucket.working', 'Working')
    case 'idle':
      return translate('dashboardPopout.bucket.idle', 'Idle')
  }
}

function groupByBucket(cards: DashboardCard[]): Record<DashboardBucket, DashboardCard[]> {
  const grouped: Record<DashboardBucket, DashboardCard[]> = {
    attention: [],
    working: [],
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

function KanbanColumn({
  bucket,
  cards,
  now,
  onOpenTerminal
}: {
  bucket: DashboardBucket
  cards: DashboardCard[]
  now: number
  onOpenTerminal: (card: DashboardCard) => void
}): React.JSX.Element {
  const highlight = bucket === 'attention' && cards.length > 0
  return (
    <section
      className={cn(
        'flex min-w-[264px] flex-1 flex-col rounded-xl border bg-muted/30',
        highlight ? 'border-amber-500/40' : 'border-border/60'
      )}
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {bucketLabel(bucket)}
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
              now={now}
              onOpenTerminal={onOpenTerminal}
            />
          ))
        )}
      </div>
    </section>
  )
}

/** The pop-out agent board: status columns fed by the relayed snapshot. */
export function AgentKanbanBoard({ snapshot }: { snapshot: DashboardSnapshot }): React.JSX.Element {
  const grouped = useMemo(() => groupByBucket(snapshot.cards), [snapshot.cards])
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
  // rows): opening a dialog acks the agent in the main renderer via the relay,
  // and the next snapshot comes back with unseen=false.
  // ?. shields dialog-opening from dev-HMR preload skew (renderer updates
  // hot, the preload only on app restart) — acks just no-op until restart.
  const handleOpenTerminal = useCallback((card: DashboardCard) => {
    void window.api.dashboard.ackAgent?.(card.paneKey)
    setOpenedCard(card)
  }, [])
  // Watching the open dialog counts as seeing state changes as they happen —
  // without this, an agent finishing while you watch would re-flag its card.
  useEffect(() => {
    if (dialogCard?.unseen) {
      void window.api.dashboard.ackAgent?.(dialogCard.paneKey)
    }
  }, [dialogCard?.unseen, dialogCard?.paneKey])

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <h1 className="text-[13px] font-semibold">
          {translate('dashboardPopout.title', 'Agents')}
        </h1>
        <span className="text-[11px] text-muted-foreground">
          {translate('dashboardPopout.total', '{{count}} total', {
            count: snapshot.cards.length
          })}
        </span>
      </div>
      <div className="scrollbar-sleek flex min-h-0 flex-1 overflow-x-auto p-3">
        {/* Why: columns share the window width up to a readable cap; mx-auto
            centers the capped board so leftover space splits evenly instead of
            pooling on the right. In overflow the auto margins collapse to 0,
            keeping the left edge reachable while scrolling. */}
        <div className="mx-auto flex w-full max-w-[1280px] gap-3">
          {DASHBOARD_BUCKET_ORDER.map((bucket) => (
            <KanbanColumn
              key={bucket}
              bucket={bucket}
              cards={grouped[bucket]}
              now={now}
              onOpenTerminal={handleOpenTerminal}
            />
          ))}
        </div>
      </div>
      <AgentTerminalDialog card={dialogCard} onOpenChange={handleDialogOpenChange} />
    </div>
  )
}
