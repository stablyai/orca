import { FleetNetworkNode } from './FleetNetworkNode'
import { FleetNetworkOutline } from './FleetNetworkOutline'
import { FleetNetworkTree } from './FleetNetworkTree'
import { FleetSoloHeader } from './FleetSoloHeader'
import { FleetTeamHeader } from './FleetTeamHeader'
import type { FleetView } from './fleet-view-model'

const SECTION_CLASS = 'min-w-0 rounded-xl border border-border/60 bg-muted/30'

export function FleetNetworkView({ view }: { view: FleetView }): React.JSX.Element {
  const now = view.window.to
  return (
    <div className="flex flex-col gap-3">
      {view.teams.map((team) => (
        <section key={team.root.card.paneKey} className={SECTION_CLASS}>
          <FleetTeamHeader team={team} now={now} className="border-b border-border/60 px-3 py-2" />
          <div className="p-3 @max-[40rem]:hidden">
            <FleetNetworkTree root={team.root} now={now} />
          </div>
          <div className="px-2 py-1 @min-[40rem]:hidden">
            <FleetNetworkOutline root={team.root} now={now} />
          </div>
        </section>
      ))}
      {view.solo.length > 0 ? (
        <section className={SECTION_CLASS}>
          <FleetSoloHeader
            count={view.solo.length}
            className="border-b border-border/60 px-3 py-2"
          />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2 p-3">
            {view.solo.map((card) => (
              <FleetNetworkNode key={card.paneKey} card={card} now={now} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
