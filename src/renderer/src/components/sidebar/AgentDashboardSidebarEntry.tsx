import { LayoutDashboard } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { DASHBOARD_BUCKET_ORDER, type DashboardBucket } from '../../../../shared/dashboard-snapshot'
import { useAgentBucketCounts } from '@/components/dashboard/useAgentBucketCounts'
import { resolveAgentDashboardMode } from '@/components/dashboard/agent-dashboard-open-mode'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import {
  SidebarRailBadge,
  SidebarRailTooltip,
  sidebarRailButtonClassName
} from './sidebar-rail-control'

const DASHBOARD_BUCKET_DOT_CLASS: Record<'working' | 'done' | 'idle', string> = {
  working: 'bg-yellow-500',
  done: 'bg-emerald-500',
  idle: 'bg-neutral-500/50'
}

function dashboardBucketLabel(bucket: DashboardBucket, t: Translate = translate): string {
  switch (bucket) {
    case 'attention':
      return t('dashboardPopout.bucket.attention', 'Needs You')
    case 'working':
      return t('dashboardPopout.bucket.working', 'Working')
    case 'done':
      return t('dashboardPopout.bucket.done', 'Done')
    case 'idle':
      return t('dashboardPopout.bucket.idle', 'Idle')
  }
}

function activeDashboardBuckets(
  counts: Record<DashboardBucket, number>,
  showIdle: boolean
): DashboardBucket[] {
  return DASHBOARD_BUCKET_ORDER.filter(
    (bucket) => counts[bucket] > 0 && (bucket !== 'idle' || showIdle)
  )
}

function DashboardBucketCounts({
  counts,
  showIdle,
  countClassName = 'text-worktree-sidebar-foreground/55'
}: {
  counts: Record<DashboardBucket, number>
  showIdle: boolean
  countClassName?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const active = activeDashboardBuckets(counts, showIdle)
  if (active.length === 0) {
    return null
  }
  return (
    <span className="flex items-center gap-1.5">
      {active.map((bucket) => (
        <span
          key={bucket}
          aria-label={`${dashboardBucketLabel(bucket, t)}: ${counts[bucket]}`}
          className={cn('inline-flex items-center gap-1 text-[10px] tabular-nums', countClassName)}
        >
          {bucket === 'attention' ? (
            <AgentQuestionIcon className="size-2.5" />
          ) : (
            <span className={cn('size-1.5 rounded-full', DASHBOARD_BUCKET_DOT_CLASS[bucket])} />
          )}
          {counts[bucket]}
        </span>
      ))}
    </span>
  )
}

export default function AgentDashboardSidebarEntry({
  compact = false
}: {
  compact?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const dashboardBucketCounts = useAgentBucketCounts()
  const showIdle = useAppStore((s) => s.settings?.experimentalAgentDashboardShowIdle === true)
  const openAsPopout = useAppStore((s) => resolveAgentDashboardMode(s.settings) === 'popout')
  const drawerOpen = useAppStore((s) => s.agentDashboardDrawerOpen)
  const setAgentDashboardDrawerOpen = useAppStore((s) => s.setAgentDashboardDrawerOpen)

  const label = t('dashboard.sidebar.dashboardLabel', 'Agent Dashboard')
  const toggleDashboard = (): void => {
    if (openAsPopout) {
      void window.api.dashboard.openPopout()
    } else {
      setAgentDashboardDrawerOpen(!drawerOpen)
    }
  }

  if (compact) {
    const activeBuckets = activeDashboardBuckets(dashboardBucketCounts, showIdle)
    const [topBucket] = activeBuckets
    return (
      <SidebarRailTooltip
        label={
          <>
            {label}
            <DashboardBucketCounts
              counts={dashboardBucketCounts}
              showIdle={showIdle}
              countClassName="text-background/70"
            />
          </>
        }
        shortcutActionId="dashboard.toggle"
      >
        <button
          type="button"
          data-contextual-tour-target="agents-sidebar"
          onClick={toggleDashboard}
          className={sidebarRailButtonClassName()}
        >
          <span className="sr-only">{label}</span>
          <LayoutDashboard className="size-4 shrink-0" strokeWidth={1.75} />
          {topBucket ? (
            <SidebarRailBadge
              label={activeBuckets
                .map(
                  (bucket) => `${dashboardBucketLabel(bucket, t)}: ${dashboardBucketCounts[bucket]}`
                )
                .join(', ')}
            >
              {topBucket === 'attention' ? (
                <AgentQuestionIcon className="size-2.5" />
              ) : (
                <span
                  className={cn('size-1.5 rounded-full', DASHBOARD_BUCKET_DOT_CLASS[topBucket])}
                />
              )}
            </SidebarRailBadge>
          ) : null}
        </button>
      </SidebarRailTooltip>
    )
  }

  return (
    <button
      type="button"
      data-contextual-tour-target="agents-sidebar"
      onClick={toggleDashboard}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
        'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
      )}
    >
      <LayoutDashboard
        className="size-4 shrink-0 text-worktree-sidebar-foreground/30"
        strokeWidth={1.75}
      />
      <span className="flex-1">{label}</span>
      <DashboardBucketCounts counts={dashboardBucketCounts} showIdle={showIdle} />
    </button>
  )
}
