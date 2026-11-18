import { FleetSoloHeader } from './FleetSoloHeader'
import { FleetTeamHeader } from './FleetTeamHeader'
import { FleetTimelineAxis } from './FleetTimelineAxis'
import { FleetTimelineRow } from './FleetTimelineRow'
import { buildFleetTimelineTicks } from './fleet-timeline-ticks'
import { flattenFleetTree } from './fleet-tree-rows'
import type { FleetView } from './fleet-view-model'

const GROUP_CLASS = 'border-t border-border/60 px-3 py-2'

export function FleetTimelineView({ view }: { view: FleetView }): React.JSX.Element {
  const ticks = buildFleetTimelineTicks(view.window)
  return (
    <div className="min-w-0 rounded-xl border border-border/60 bg-muted/30">
      <FleetTimelineAxis ticks={ticks} className="px-3" />
      {view.teams.map((team) => (
        <section key={team.root.card.paneKey} className={GROUP_CLASS}>
          <FleetTeamHeader team={team} now={view.window.to} className="pb-1" />
          {flattenFleetTree(team.root).map((row) => (
            <FleetTimelineRow
              key={row.card.paneKey}
              row={row}
              timeWindow={view.window}
              ticks={ticks}
            />
          ))}
        </section>
      ))}
      {view.solo.length > 0 ? (
        <section className={GROUP_CLASS}>
          <FleetSoloHeader count={view.solo.length} className="pb-1" />
          {view.solo.map((card) => (
            <FleetTimelineRow
              key={card.paneKey}
              row={{
                card,
                depth: 0,
                isLastSibling: true,
                continuingAncestors: [],
                hasChildren: false
              }}
              timeWindow={view.window}
              ticks={ticks}
            />
          ))}
        </section>
      ) : null}
    </div>
  )
}
