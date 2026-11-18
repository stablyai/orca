import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { FleetBucketCountChips } from './FleetBucketCountChips'
import { fleetCardTitle, fleetElapsed } from './fleet-card-text'
import type { FleetTeam } from './fleet-view-model'

export function FleetTeamHeader({
  team,
  now,
  className
}: {
  team: FleetTeam
  now: number
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const root = team.root.card
  return (
    <header className={cn('flex min-w-0 items-center gap-2', className)}>
      <span className="inline-flex shrink-0">
        <AgentTypeIcon agentType={root.agentType} size={14} />
      </span>
      <h3 className="min-w-0 truncate text-[13px] font-semibold">{fleetCardTitle(root)}</h3>
      <span className="shrink-0 text-2xs text-muted-foreground">
        {t('dashboard.fleet.team.members', '{{count}} agents', {
          count: team.size,
          defaultValue_one: '{{count}} agent'
        })}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-3">
        <FleetBucketCountChips counts={team.counts} />
        <span className="text-2xs tabular-nums text-muted-foreground">
          {fleetElapsed(team.startedAt, team.endedAt ?? now)}
        </span>
      </span>
    </header>
  )
}
