import { Bot, FolderGit2, Network } from 'lucide-react'
import { AgentStateDot } from '@/components/agent/status/AgentStateDot'
import { useTranslate } from '@/i18n/use-translate'
import type { DashboardBucket } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { dashboardBucketLabel } from '../board/dashboard-bucket-label'
import { FLEET_BUCKET_DOT_STATE } from './fleet-bucket-presentation'
import type { FleetView } from './fleet-view-model'

type FleetSummaryTile = { key: string; label: string; value: number; icon: React.ReactNode }

export function FleetSummaryBand({
  summary,
  buckets
}: {
  summary: FleetView['summary']
  buckets: readonly DashboardBucket[]
}): React.JSX.Element {
  const t = useTranslate()
  const tiles: FleetSummaryTile[] = [
    {
      key: 'agents',
      label: t('dashboardPopout.fleet.summary.agents', 'Agents'),
      value: summary.agents,
      icon: <Bot className="size-3" aria-hidden />
    },
    {
      key: 'projects',
      label: t('dashboardPopout.fleet.summary.projects', 'Projects'),
      value: summary.projects,
      icon: <FolderGit2 className="size-3" aria-hidden />
    },
    {
      key: 'teams',
      label: t('dashboardPopout.fleet.summary.teams', 'Teams'),
      value: summary.teams,
      icon: <Network className="size-3" aria-hidden />
    },
    ...buckets.map((bucket) => ({
      key: bucket,
      label: dashboardBucketLabel(bucket, t),
      value: summary[bucket],
      icon: <AgentStateDot state={FLEET_BUCKET_DOT_STATE[bucket]} title={null} />
    }))
  ]
  return (
    <div className="grid auto-cols-[minmax(0,1fr)] grid-flow-col gap-2 @max-[40rem]:grid-flow-row @max-[40rem]:grid-cols-4">
      {tiles.map((tile) => (
        <div
          key={tile.key}
          className="flex min-w-0 flex-col gap-1 rounded-lg border border-border/60 bg-card px-3 py-2"
        >
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            {tile.icon}
            <span className="truncate text-2xs font-semibold tracking-wider uppercase">
              {tile.label}
            </span>
          </span>
          <span className="text-lg font-semibold tabular-nums">{tile.value}</span>
        </div>
      ))}
    </div>
  )
}
