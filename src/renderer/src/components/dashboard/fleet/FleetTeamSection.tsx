import type { FleetCardOpener } from './FleetNetworkNode'
import { FleetNetworkOutline } from './FleetNetworkOutline'
import { FleetNetworkTree } from './FleetNetworkTree'
import { FleetTeamHeader } from './FleetTeamHeader'
import type { FleetTeamLayout } from './fleet-team-fold'
import type { FleetTeam } from './fleet-view-model'

export const FLEET_SECTION_CLASS = 'min-w-0 rounded-xl border border-border/60 bg-muted/30'

export function FleetTeamSection({
  team,
  layout,
  now,
  onOpenCard
}: {
  team: FleetTeam
  layout: FleetTeamLayout
  now: number
  onOpenCard: FleetCardOpener
}): React.JSX.Element {
  return (
    <section className={FLEET_SECTION_CLASS}>
      <FleetTeamHeader team={team} />
      {layout === 'tree' ? (
        <div className="p-3">
          <FleetNetworkTree root={team.root} now={now} onOpenCard={onOpenCard} />
        </div>
      ) : (
        <div className="px-2 py-1">
          <FleetNetworkOutline root={team.root} now={now} onOpenCard={onOpenCard} />
        </div>
      )}
    </section>
  )
}
