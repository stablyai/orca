import type { FleetCardOpener } from './FleetNetworkNode'
import { FleetNetworkOutline } from './FleetNetworkOutline'
import { FleetNetworkTree } from './FleetNetworkTree'
import { FleetTeamHeader } from './FleetTeamHeader'
import { FLEET_TEAM_TREE_INSET_PX, type FleetTeamLayout } from './fleet-team-fold'
import type { FleetProject, FleetTeam } from './fleet-view-model'

export function FleetTeamSection({
  team,
  project,
  layout,
  now,
  onOpenCard
}: {
  team: FleetTeam
  project: FleetProject
  layout: FleetTeamLayout
  now: number
  onOpenCard: FleetCardOpener
}): React.JSX.Element {
  return (
    <section className="border-t border-border/60">
      <FleetTeamHeader team={team} />
      {layout === 'tree' ? (
        <div className="pb-3" style={{ paddingInline: FLEET_TEAM_TREE_INSET_PX }}>
          <FleetNetworkTree root={team.root} project={project} now={now} onOpenCard={onOpenCard} />
        </div>
      ) : (
        <div className="px-2 pb-2">
          <FleetNetworkOutline
            root={team.root}
            project={project}
            now={now}
            onOpenCard={onOpenCard}
          />
        </div>
      )}
    </section>
  )
}
