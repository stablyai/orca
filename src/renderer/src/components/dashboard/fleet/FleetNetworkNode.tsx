import { memo } from 'react'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { AgentQuestionIcon } from '@/components/agent/status/AgentQuestionIcon'
import { AgentStateDot } from '@/components/agent/status/AgentStateDot'
import { cn } from '@/lib/class-names'
import {
  dashboardCardDisplayState,
  type DashboardCard
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { sameDashboardCard } from '../board/dashboard-card-equality'
import {
  dashboardCardAgeBucket,
  dashboardCardSurfaceClass,
  type DashboardCardAgeBucket
} from '../board/dashboard-card-presentation'
import { FleetNodeLocation } from './FleetNodeLocation'
import { FleetNodeSubagents } from './FleetNodeSubagents'
import type { FleetAgeFormatter } from './fleet-age-formatter'
import { fleetCardTitle } from './fleet-card-title'
import type { FleetProject } from './fleet-view-model'

export type FleetCardOpener = (card: DashboardCard) => void

type FleetNetworkNodeProps = {
  card: DashboardCard
  project: FleetProject
  now: number
  formatAge: FleetAgeFormatter
  onOpenCard: FleetCardOpener
  maxWidthPx?: number
}

function sameAgeBucket(
  a: DashboardCardAgeBucket | null,
  b: DashboardCardAgeBucket | null
): boolean {
  return a === null || b === null ? a === b : a.unit === b.unit && a.count === b.count
}

function sameFleetNode(previous: FleetNetworkNodeProps, next: FleetNetworkNodeProps): boolean {
  return (
    previous.onOpenCard === next.onOpenCard &&
    previous.formatAge === next.formatAge &&
    previous.maxWidthPx === next.maxWidthPx &&
    previous.project.key === next.project.key &&
    previous.card.workspaceKind === next.card.workspaceKind &&
    sameDashboardCard(previous.card, next.card) &&
    sameAgeBucket(
      dashboardCardAgeBucket(previous.card, previous.now),
      dashboardCardAgeBucket(next.card, next.now)
    )
  )
}

export const FleetNetworkNode = memo(function FleetNetworkNode({
  card,
  project,
  now,
  formatAge,
  onOpenCard,
  maxWidthPx
}: FleetNetworkNodeProps): React.JSX.Element {
  const age = dashboardCardAgeBucket(card, now)
  const ageLabel = age ? formatAge(age) : null
  return (
    <button
      type="button"
      onClick={() => onOpenCard(card)}
      style={{ maxWidth: maxWidthPx }}
      className={cn(
        'flex w-full min-w-0 flex-col gap-1 rounded-lg border p-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        dashboardCardSurfaceClass(card)
      )}
    >
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <AgentStateDot state={dashboardCardDisplayState(card)} />
        <span className="inline-flex shrink-0">
          <AgentTypeIcon agentType={card.agentType} size={14} />
        </span>
        <span className="truncate text-xs font-medium text-foreground">{fleetCardTitle(card)}</span>
      </span>
      {card.askSummary ? (
        <span className="flex w-full min-w-0 items-center gap-1 text-2xs text-agent-question-text">
          <AgentQuestionIcon className="size-3 shrink-0" />
          <span className="truncate">{card.askSummary}</span>
        </span>
      ) : card.lastAgentMessage ? (
        <span className="w-full truncate text-2xs text-muted-foreground">
          {card.lastAgentMessage}
        </span>
      ) : null}
      {card.subagents?.length ? <FleetNodeSubagents subagents={card.subagents} /> : null}
      <span className="flex w-full min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
        <FleetNodeLocation card={card} project={project} />
        {ageLabel ? <span className="ml-auto shrink-0 pl-1 tabular-nums">{ageLabel}</span> : null}
      </span>
    </button>
  )
}, sameFleetNode)
