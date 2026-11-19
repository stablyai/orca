import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { cn } from '@/lib/class-names'
import type { RepoIcon } from '../../../../../shared/repository/appearance/repo-icon'
import { FleetNetworkNode, type FleetCardOpener } from './FleetNetworkNode'
import { FleetProjectHeader } from './FleetProjectHeader'
import { FleetSoloHeader } from './FleetSoloHeader'
import { FleetTeamSection } from './FleetTeamSection'
import { fleetFoldedAttentionClass } from './fleet-bucket-presentation'
import { fleetTeamLayout } from './fleet-team-fold'
import type { FleetProject } from './fleet-view-model'

export function FleetProjectSection({
  project,
  repoIcon,
  open,
  onOpenChange,
  width,
  now,
  onOpenCard
}: {
  project: FleetProject
  repoIcon: RepoIcon | null | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  width: number
  now: number
  onOpenCard: FleetCardOpener
}): React.JSX.Element {
  return (
    <Collapsible asChild open={open} onOpenChange={onOpenChange}>
      <section
        className={cn(
          'min-w-0 rounded-xl border border-border/60 bg-muted/30',
          fleetFoldedAttentionClass(open, project.counts)
        )}
      >
        <FleetProjectHeader project={project} repoIcon={repoIcon} />
        <CollapsibleContent>
          {project.teams.map((team) => (
            <FleetTeamSection
              key={team.root.card.paneKey}
              team={team}
              project={project}
              layout={fleetTeamLayout(team.root.leafCount, width)}
              now={now}
              onOpenCard={onOpenCard}
            />
          ))}
          {project.solo.length > 0 ? (
            <section className="border-t border-border/60">
              <FleetSoloHeader count={project.solo.length} />
              <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2 px-3 pb-3">
                {project.solo.map((card) => (
                  <FleetNetworkNode
                    key={card.paneKey}
                    card={card}
                    project={project}
                    now={now}
                    onOpenCard={onOpenCard}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}
