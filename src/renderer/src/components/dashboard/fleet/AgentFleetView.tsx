import { useMemo, useState } from 'react'
import { useMeasuredWidth } from '@/components/right-sidebar/layout/right-sidebar-measured-width'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type {
  DashboardBucket,
  DashboardCard
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { FleetNetworkNode, type FleetCardOpener } from './FleetNetworkNode'
import { FleetSoloHeader } from './FleetSoloHeader'
import { FleetSummaryBand } from './FleetSummaryBand'
import { FLEET_SECTION_CLASS, FleetTeamSection } from './FleetTeamSection'
import { fleetTeamLayout } from './fleet-team-fold'
import { buildFleetView } from './fleet-view-model'

export function AgentFleetView({
  cards,
  buckets,
  now,
  onOpenCard,
  className
}: {
  cards: readonly DashboardCard[]
  buckets: readonly DashboardBucket[]
  now: number
  onOpenCard: FleetCardOpener
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const view = useMemo(() => buildFleetView(cards), [cards])
  const [width, setWidth] = useState<number | null>(null)
  const measureRef = useMeasuredWidth(setWidth)
  return (
    <div ref={measureRef} className={cn('@container flex flex-col gap-3', className)}>
      <FleetSummaryBand summary={view.summary} buckets={buckets} />
      {view.summary.agents === 0 ? (
        <p className="px-1 text-2xs text-muted-foreground">
          {t('dashboardPopout.fleet.empty', 'No agents')}
        </p>
      ) : null}
      {width === null
        ? null
        : view.teams.map((team) => (
            <FleetTeamSection
              key={team.root.card.paneKey}
              team={team}
              layout={fleetTeamLayout(team.root.leafCount, width)}
              now={now}
              onOpenCard={onOpenCard}
            />
          ))}
      {view.solo.length > 0 ? (
        <section className={FLEET_SECTION_CLASS}>
          <FleetSoloHeader count={view.solo.length} />
          <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2 p-3">
            {view.solo.map((card) => (
              <FleetNetworkNode key={card.paneKey} card={card} now={now} onOpenCard={onOpenCard} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
