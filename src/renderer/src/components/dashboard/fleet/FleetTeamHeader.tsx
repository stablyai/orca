import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import { useTranslate } from '@/i18n/use-translate'
import { FleetBucketCountChips } from './FleetBucketCountChips'
import { fleetCardTitle } from './fleet-card-title'
import type { FleetTeam } from './fleet-view-model'

export function FleetTeamHeader({ team }: { team: FleetTeam }): React.JSX.Element {
  const t = useTranslate()
  const root = team.root.card
  return (
    <header className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2">
      <span className="inline-flex shrink-0">
        <AgentTypeIcon agentType={root.agentType} size={14} />
      </span>
      <h3 className="min-w-0 truncate text-[13px] font-semibold">{fleetCardTitle(root)}</h3>
      <span className="shrink-0 text-2xs text-muted-foreground">
        {t('dashboardPopout.fleet.team.members', '{{count}} agents', {
          count: team.size,
          defaultValue_one: '{{count}} agent'
        })}
      </span>
      <span className="ml-auto shrink-0">
        <FleetBucketCountChips counts={team.counts} />
      </span>
    </header>
  )
}
