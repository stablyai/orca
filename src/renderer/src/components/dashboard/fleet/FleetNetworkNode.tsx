import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { AgentQuestionIcon } from '@/components/agent/status/AgentQuestionIcon'
import { AgentStateDot } from '@/components/agent/status/AgentStateDot'
import { cn } from '@/lib/class-names'
import {
  dashboardCardDisplayState,
  type DashboardCard
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { DashboardHostBadge } from '../board/DashboardHostBadge'
import { fleetCardSurfaceClass } from './fleet-bucket-presentation'
import { fleetCardElapsed, fleetCardTitle } from './fleet-card-text'

export function FleetNetworkNode({
  card,
  now,
  className
}: {
  card: DashboardCard
  now: number
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex w-full min-w-0 flex-col gap-1 rounded-lg border p-2 text-left',
        fleetCardSurfaceClass(card),
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <AgentStateDot state={dashboardCardDisplayState(card)} />
        <span className="inline-flex shrink-0">
          <AgentTypeIcon agentType={card.agentType} size={14} />
        </span>
        <span className="truncate text-xs font-medium text-foreground">{fleetCardTitle(card)}</span>
      </div>
      {card.askSummary ? (
        <div className="flex min-w-0 items-center gap-1 text-2xs text-agent-question-text">
          <AgentQuestionIcon className="size-3 shrink-0" />
          <span className="truncate">{card.askSummary}</span>
        </div>
      ) : card.lastAgentMessage ? (
        <p className="truncate text-2xs text-muted-foreground">{card.lastAgentMessage}</p>
      ) : null}
      <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
        <span className="truncate">{card.worktreeName}</span>
        <DashboardHostBadge
          hostKind={card.hostKind}
          executionHostId={card.executionHostId}
          hostLabel={card.hostLabel}
        />
        <span className="ml-auto shrink-0 pl-1 tabular-nums">{fleetCardElapsed(card, now)}</span>
      </div>
    </div>
  )
}
