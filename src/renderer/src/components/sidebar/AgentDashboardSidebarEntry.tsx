import { LayoutDashboard } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { DASHBOARD_BUCKET_ORDER, type DashboardBucket } from '../../../../shared/dashboard-snapshot'
import { useAgentBucketCounts } from '@/components/dashboard/useAgentBucketCounts'
import { translate } from '@/i18n/i18n'

const DASHBOARD_BUCKET_DOT_CLASS: Record<'working' | 'done' | 'idle', string> = {
  working: 'bg-yellow-500',
  done: 'bg-emerald-500',
  idle: 'bg-neutral-500/50'
}

function dashboardBucketLabel(bucket: DashboardBucket): string {
  switch (bucket) {
    case 'attention':
      return translate('dashboardPopout.bucket.attention', 'Needs You')
    case 'working':
      return translate('dashboardPopout.bucket.working', 'Working')
    case 'done':
      return translate('dashboardPopout.bucket.done', 'Done')
    case 'idle':
      return translate('dashboardPopout.bucket.idle', 'Idle')
  }
}

/** Inline per-bucket agent counts; hides empty buckets and idle unless `showIdle`. */
function DashboardBucketCounts({
  counts,
  showIdle
}: {
  counts: Record<DashboardBucket, number>
  showIdle: boolean
}): React.JSX.Element | null {
  const active = DASHBOARD_BUCKET_ORDER.filter(
    (bucket) => counts[bucket] > 0 && (bucket !== 'idle' || showIdle)
  )
  if (active.length === 0) {
    return null
  }
  return (
    <span className="flex items-center gap-1.5">
      {active.map((bucket) => (
        <span
          key={bucket}
          aria-label={`${dashboardBucketLabel(bucket)}: ${counts[bucket]}`}
          className="inline-flex items-center gap-1 text-[10px] tabular-nums text-muted-foreground/90"
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

/** Sidebar nav row that opens the agent dashboard as a drawer or popout per settings. */
export default function AgentDashboardSidebarEntry(): React.JSX.Element {
  const dashboardBucketCounts = useAgentBucketCounts()
  const showIdle = useAppStore((s) => s.settings?.experimentalAgentDashboardShowIdle === true)
  const openAsPopout = useAppStore((s) => s.settings?.experimentalAgentDashboardMode === 'popout')
  const drawerOpen = useAppStore((s) => s.agentDashboardDrawerOpen)
  const setAgentDashboardDrawerOpen = useAppStore((s) => s.setAgentDashboardDrawerOpen)

  return (
    <button
      type="button"
      onClick={() => {
        if (openAsPopout) {
          void window.api.dashboard.openPopout()
        } else {
          setAgentDashboardDrawerOpen(!drawerOpen)
        }
      }}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
        'text-muted-foreground hover:bg-worktree-sidebar-foreground/8'
      )}
    >
      <LayoutDashboard className="size-4 shrink-0 text-muted-foreground/50" strokeWidth={1.75} />
      <span className="flex-1">{translate('dashboard.sidebar.label', 'Agent Dashboard')}</span>
      <DashboardBucketCounts counts={dashboardBucketCounts} showIdle={showIdle} />
    </button>
  )
}
