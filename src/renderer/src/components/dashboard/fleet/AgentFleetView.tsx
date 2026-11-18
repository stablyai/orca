import { useMemo } from 'react'
import {
  DASHBOARD_BUCKET_ORDER,
  type DashboardSnapshot
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { FleetNetworkView } from './FleetNetworkView'
import { FleetSummaryBand } from './FleetSummaryBand'
import { buildFleetView } from './fleet-view-model'

export function AgentFleetView({
  snapshot,
  now
}: {
  snapshot: DashboardSnapshot
  now: number
}): React.JSX.Element {
  const buckets = useMemo(
    () =>
      DASHBOARD_BUCKET_ORDER.filter((bucket) => bucket !== 'idle' || snapshot.showIdle === true),
    [snapshot.showIdle]
  )
  const view = useMemo(
    () => buildFleetView(snapshot.cards.filter((card) => buckets.includes(card.bucket))),
    [snapshot.cards, buckets]
  )
  return (
    <div className="@container flex flex-col gap-3 bg-background text-foreground">
      <FleetSummaryBand summary={view.summary} buckets={buckets} />
      <FleetNetworkView view={view} now={now} />
    </div>
  )
}
