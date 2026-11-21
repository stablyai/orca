import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { cn } from '@/lib/class-names'
import type { FleetCardOpener } from './FleetNetworkNode'
import { FleetNetworkOutline } from './FleetNetworkOutline'
import { FleetNetworkTree } from './FleetNetworkTree'
import { FleetTeamHeader } from './FleetTeamHeader'
import type { FleetAgeFormatter } from './fleet-age-formatter'
import { fleetFoldedAttentionClass } from './fleet-bucket-presentation'
import { FLEET_TEAM_TREE_INSET_PX, type FleetTeamLayout } from './fleet-team-fold'
import type { FleetProject, FleetTeam } from './fleet-view-model'

export function FleetTeamSection({
  team,
  project,
  layout,
  open,
  onOpenChange,
  now,
  formatAge,
  onOpenCard
}: {
  team: FleetTeam
  project: FleetProject
  layout: FleetTeamLayout
  open: boolean
  onOpenChange: (open: boolean) => void
  now: number
  formatAge: FleetAgeFormatter
  onOpenCard: FleetCardOpener
}): React.JSX.Element {
  return (
    <Collapsible asChild open={open} onOpenChange={onOpenChange}>
      <section
        className={cn('border-t border-border/60', fleetFoldedAttentionClass(open, team.counts))}
      >
        <FleetTeamHeader team={team} />
        <CollapsibleContent>
          {layout === 'tree' ? (
            <div className="pb-3" style={{ paddingInline: FLEET_TEAM_TREE_INSET_PX }}>
              <FleetNetworkTree
                root={team.root}
                project={project}
                now={now}
                formatAge={formatAge}
                onOpenCard={onOpenCard}
              />
            </div>
          ) : (
            <div className="px-2 pb-2">
              <FleetNetworkOutline
                root={team.root}
                project={project}
                now={now}
                formatAge={formatAge}
                onOpenCard={onOpenCard}
              />
            </div>
          )}
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}
