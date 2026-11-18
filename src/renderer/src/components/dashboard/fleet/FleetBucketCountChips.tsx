import { AgentStateDot } from '@/components/agent/status/AgentStateDot'
import { useTranslate } from '@/i18n/use-translate'
import { DASHBOARD_BUCKET_ORDER } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { dashboardBucketLabel } from '../board/dashboard-bucket-label'
import { FLEET_BUCKET_DOT_STATE } from './fleet-bucket-presentation'
import type { FleetBucketCounts } from './fleet-view-model'

export function FleetBucketCountChips({
  counts
}: {
  counts: FleetBucketCounts
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <span className="flex shrink-0 items-center gap-2">
      {DASHBOARD_BUCKET_ORDER.filter((bucket) => counts[bucket] > 0).map((bucket) => {
        const label = dashboardBucketLabel(bucket, t)
        return (
          <span
            key={bucket}
            aria-label={`${label}: ${counts[bucket]}`}
            className="inline-flex items-center gap-1 text-2xs tabular-nums text-muted-foreground"
          >
            <AgentStateDot state={FLEET_BUCKET_DOT_STATE[bucket]} title={label} />
            {counts[bucket]}
          </span>
        )
      })}
    </span>
  )
}
