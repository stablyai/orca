import { useMemo, useState } from 'react'
import { useMeasuredWidth } from '@/components/right-sidebar/layout/right-sidebar-measured-width'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type {
  DashboardBucket,
  DashboardCard
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import type { RepoIcon } from '../../../../../shared/repository/appearance/repo-icon'
import type { FleetCardOpener } from './FleetNetworkNode'
import { FleetProjectSection } from './FleetProjectSection'
import { FleetSummaryBand } from './FleetSummaryBand'
import {
  loadFleetCollapsedProjects,
  saveFleetCollapsedProjects
} from './fleet-collapsed-projects-storage'
import { buildFleetView } from './fleet-view-model'

export function AgentFleetView({
  cards,
  buckets,
  repoIconsByRepoId,
  now,
  onOpenCard,
  className
}: {
  cards: readonly DashboardCard[]
  buckets: readonly DashboardBucket[]
  repoIconsByRepoId: Record<string, RepoIcon | null> | undefined
  now: number
  onOpenCard: FleetCardOpener
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  const view = useMemo(() => buildFleetView(cards), [cards])
  const [width, setWidth] = useState<number | null>(null)
  const measureRef = useMeasuredWidth(setWidth)
  const [collapsedKeys, setCollapsedKeys] = useState(loadFleetCollapsedProjects)
  const setProjectOpen = (key: string, open: boolean): void => {
    const next = new Set(collapsedKeys)
    if (open) {
      next.delete(key)
    } else {
      next.add(key)
    }
    setCollapsedKeys(next)
    saveFleetCollapsedProjects(next)
  }
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
        : view.projects.map((project) => (
            <FleetProjectSection
              key={project.key}
              project={project}
              repoIcon={repoIconsByRepoId?.[project.repoId]}
              open={!collapsedKeys.has(project.key)}
              onOpenChange={(open) => setProjectOpen(project.key, open)}
              width={width}
              now={now}
              onOpenCard={onOpenCard}
            />
          ))}
    </div>
  )
}
