import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { FleetAgentCount } from './FleetAgentCount'
import { FleetBucketCountChips } from './FleetBucketCountChips'
import { fleetCardTitle } from './fleet-card-title'
import type { FleetTeam } from './fleet-view-model'

export function FleetTeamHeader({ team }: { team: FleetTeam }): React.JSX.Element {
  const root = team.root.card
  return (
    <header className="flex min-w-0 items-center gap-2 px-3 py-2">
      <span className="inline-flex shrink-0">
        <AgentTypeIcon agentType={root.agentType} size={14} />
      </span>
      <h3 className="min-w-0 truncate text-xs font-medium">{fleetCardTitle(root)}</h3>
      <FleetAgentCount count={team.size} />
      <span className="ml-auto shrink-0">
        <FleetBucketCountChips counts={team.counts} />
      </span>
    </header>
  )
}
