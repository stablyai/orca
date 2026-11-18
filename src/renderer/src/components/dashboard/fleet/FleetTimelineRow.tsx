import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { AgentStateDot } from '@/components/agent/status/AgentStateDot'
import { cn } from '@/lib/class-names'
import { dashboardCardDisplayState } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { DashboardHostBadge } from '../board/DashboardHostBadge'
import { FLEET_BUCKET_BAR_CLASS } from './fleet-bucket-presentation'
import { fleetCardElapsed, fleetCardTitle } from './fleet-card-text'
import { fleetTimelineGridClass } from './fleet-timeline-grid'
import { fleetTimelinePercent, type FleetTimelineTick } from './fleet-timeline-ticks'
import type { FleetTreeRow } from './fleet-tree-rows'
import { FLEET_GUIDE_LINE_CLASS, FleetTreeGuides } from './FleetTreeGuides'
import { fleetCardEnd, type FleetView } from './fleet-view-model'

export function FleetTimelineRow({
  row,
  timeWindow,
  ticks
}: {
  row: FleetTreeRow
  timeWindow: FleetView['window']
  ticks: readonly FleetTimelineTick[]
}): React.JSX.Element {
  const { card } = row
  const start = fleetTimelinePercent(timeWindow, card.startedAt)
  const end = fleetTimelinePercent(timeWindow, fleetCardEnd(card, timeWindow.to))
  return (
    <div className={cn(fleetTimelineGridClass, 'h-8')}>
      <div className="flex h-full min-w-0 items-center">
        <FleetTreeGuides row={row} geometry="row" />
        <span className="relative flex w-2.5 shrink-0 items-center self-stretch">
          <AgentStateDot state={dashboardCardDisplayState(card)} />
          {row.hasChildren ? (
            <span
              aria-hidden
              className={cn(
                'absolute top-[calc(50%+6px)] bottom-0 left-1 border-l',
                FLEET_GUIDE_LINE_CLASS
              )}
            />
          ) : null}
        </span>
        <span className="ml-1.5 inline-flex shrink-0">
          <AgentTypeIcon agentType={card.agentType} size={14} />
        </span>
        <span
          className={cn(
            'ml-1.5 truncate text-xs',
            row.depth === 0 ? 'font-medium text-foreground' : 'text-foreground/90'
          )}
        >
          {fleetCardTitle(card)}
        </span>
        <DashboardHostBadge
          hostKind={card.hostKind}
          executionHostId={card.executionHostId}
          hostLabel={card.hostLabel}
          className="ml-1.5"
        />
      </div>
      <div className="relative h-full @max-[40rem]:hidden">
        {ticks.map((tick) => (
          <span
            key={tick.minutesAgo}
            aria-hidden
            className="absolute inset-y-0 border-l border-border/50"
            style={{ left: `${tick.percent}%` }}
          />
        ))}
        <span
          aria-hidden
          className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-foreground/5"
        />
        {card.startedAt > 0 ? (
          <span
            className={cn(
              'absolute top-1/2 h-1.5 min-w-1.5 -translate-y-1/2 rounded-full',
              FLEET_BUCKET_BAR_CLASS[card.bucket]
            )}
            style={{ left: `${start}%`, width: `${end - start}%` }}
          />
        ) : null}
      </div>
      <span className="text-right text-2xs tabular-nums text-muted-foreground">
        {fleetCardElapsed(card, timeWindow.to)}
      </span>
    </div>
  )
}
