import { ChevronRight } from 'lucide-react'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/class-names'
import { FleetAgentCount } from './FleetAgentCount'
import { FleetBucketCountChips } from './FleetBucketCountChips'
import { fleetCardTitle } from './fleet-card-title'
import type { FleetTeam } from './fleet-view-model'

export function FleetTeamHeader({ team }: { team: FleetTeam }): React.JSX.Element {
  const root = team.root.card
  return (
    <h3 className="flex min-w-0">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-2 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <ChevronRight
            className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
            aria-hidden
          />
          <span className="inline-flex shrink-0">
            <AgentTypeIcon agentType={root.agentType} size={14} />
          </span>
          <span
            className={cn(
              'min-w-0 truncate text-xs',
              team.settled ? 'text-muted-foreground' : 'font-medium text-foreground'
            )}
          >
            {fleetCardTitle(root)}
          </span>
          <FleetAgentCount count={team.size} />
          <span className="ml-auto shrink-0">
            <FleetBucketCountChips counts={team.counts} />
          </span>
        </button>
      </CollapsibleTrigger>
    </h3>
  )
}
