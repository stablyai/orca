import { memo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { AgentStateDot } from '@/components/agent/status/AgentStateDot'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import {
  dashboardCardDisplayState,
  type DashboardBucket,
  type DashboardCard
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import type { DashboardLane } from './agent-board-projection'
import { displayTimestamp, formatStartedAgo } from './AgentKanbanCard'

type AgentDashboardDockedRackProps = {
  cards: DashboardCard[]
  lanes: Record<DashboardBucket, DashboardLane>
  buckets: DashboardBucket[]
  bucketLabel: (bucket: DashboardBucket) => string
  now: number
  /** Keep the terminal dialog's opener mounted so closing it can return focus there. */
  dialogPaneKey: string | null
  onOpenTerminal: (card: DashboardCard) => void
}

type DockedAgentRowProps = {
  card: DashboardCard
  now: number
  onOpenTerminal: (card: DashboardCard) => void
}

/** One agent as a sidebar-density row; the project prefix tells default-branch workspaces ("main") apart. */
const DockedAgentRow = memo(
  function DockedAgentRow({ card, now, onOpenTerminal }: DockedAgentRowProps): React.JSX.Element {
    const t = useTranslate()
    const secondary = card.askSummary ?? card.task
    return (
      <button
        type="button"
        onClick={() => onOpenTerminal(card)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="inline-flex shrink-0">
          <AgentTypeIcon agentType={card.agentType} size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px]">
            <span className="text-muted-foreground">{card.repoName} · </span>
            {card.worktreeName}
            {/* The workspace stays: two conversations in one project would otherwise read alike. */}
            {card.conversationName ? (
              <span className="text-muted-foreground"> · {card.conversationName}</span>
            ) : null}
          </span>
          {secondary ? (
            <span
              className={cn(
                'block truncate text-xs',
                card.askSummary ? 'text-agent-question-text' : 'text-muted-foreground'
              )}
            >
              {secondary}
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <AgentStateDot state={dashboardCardDisplayState(card)} />
          {/* Title-derived rows have no start time; an age from 0 would read as decades. */}
          {displayTimestamp(card) > 0 ? (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {formatStartedAgo(displayTimestamp(card), now, t)}
            </span>
          ) : null}
        </span>
      </button>
    )
  },
  // Snapshots rebuild card objects, so compare what the row shows; a fleet would otherwise repaint every row per hook event.
  (previous, next) =>
    previous.now === next.now &&
    previous.onOpenTerminal === next.onOpenTerminal &&
    previous.card.agentType === next.card.agentType &&
    previous.card.repoName === next.card.repoName &&
    previous.card.conversationName === next.card.conversationName &&
    previous.card.worktreeName === next.card.worktreeName &&
    previous.card.askSummary === next.card.askSummary &&
    previous.card.task === next.card.task &&
    displayTimestamp(previous.card) === displayTimestamp(next.card) &&
    dashboardCardDisplayState(previous.card) === dashboardCardDisplayState(next.card)
)

/** The board for a narrow dock: status groups stacked like a rack, each foldable, instead of side-by-side lanes. */
export function AgentDashboardDockedRack({
  cards,
  lanes,
  buckets,
  bucketLabel,
  now,
  dialogPaneKey,
  onOpenTerminal
}: AgentDashboardDockedRackProps): React.JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<DashboardBucket>>(new Set())
  const toggle = (bucket: DashboardBucket): void =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (!next.delete(bucket)) {
        next.add(bucket)
      }
      return next
    })

  // Headers and rows are siblings of one list so a card moving between groups keeps its DOM node (and focus).
  return (
    <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
      {buckets.flatMap((bucket) => {
        const isCollapsed = collapsed.has(bucket)
        const Chevron = isCollapsed ? ChevronRight : ChevronDown
        const laneCards = lanes[bucket].indexes.map((index) => cards[index]).filter(Boolean)
        return [
          <button
            key={`bucket:${bucket}`}
            type="button"
            aria-expanded={!isCollapsed}
            onClick={() => toggle(bucket)}
            className="mt-2 flex w-full items-center gap-1 px-2 py-1 text-[11px] font-medium tracking-[0.05em] text-muted-foreground uppercase first:mt-0 hover:text-foreground"
          >
            <Chevron className="size-3.5" />
            <span>{bucketLabel(bucket)}</span>
            <span className="ml-auto rounded-full bg-muted px-1.5 tabular-nums">
              {laneCards.length}
            </span>
          </button>,
          ...laneCards
            .filter((card) => !isCollapsed || card.paneKey === dialogPaneKey)
            .map((card) => (
              <DockedAgentRow
                key={card.paneKey}
                card={card}
                now={now}
                onOpenTerminal={onOpenTerminal}
              />
            ))
        ]
      })}
    </div>
  )
}
