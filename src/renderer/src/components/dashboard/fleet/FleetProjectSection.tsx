import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { cn } from '@/lib/class-names'
import type { RepoIcon } from '../../../../../shared/repository/appearance/repo-icon'
import { FleetNetworkNode, type FleetCardOpener } from './FleetNetworkNode'
import { FleetProjectHeader } from './FleetProjectHeader'
import { FleetSoloHeader } from './FleetSoloHeader'
import { FleetTeamSection } from './FleetTeamSection'
import type { FleetAgeFormatter } from './fleet-age-formatter'
import { fleetFoldedAttentionClass } from './fleet-bucket-presentation'
import { fleetTeamLayout } from './fleet-team-fold'
import type { FleetProject } from './fleet-view-model'

/** The user's open or closed choice per team, keyed by root pane; unlisted teams follow `settled`. */
export type FleetTeamOpenOverrides = ReadonlyMap<string, boolean>
export type FleetTeamOpenChange = (rootPaneKey: string, open: boolean) => void

export function FleetProjectSection({
  project,
  repoIcon,
  open,
  onOpenChange,
  teamOpenOverrides,
  onTeamOpenChange,
  width,
  now,
  formatAge,
  onOpenCard
}: {
  project: FleetProject
  repoIcon: RepoIcon | null | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  teamOpenOverrides: FleetTeamOpenOverrides
  onTeamOpenChange: FleetTeamOpenChange
  width: number
  now: number
  formatAge: FleetAgeFormatter
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
              layout={fleetTeamLayout(team.root, width)}
              open={teamOpenOverrides.get(team.root.card.paneKey) ?? !team.settled}
              onOpenChange={(teamOpen) => onTeamOpenChange(team.root.card.paneKey, teamOpen)}
              now={now}
              formatAge={formatAge}
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
                    formatAge={formatAge}
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
