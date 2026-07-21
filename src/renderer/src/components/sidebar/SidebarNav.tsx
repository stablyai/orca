import React from 'react'
import { Bell, CalendarClock, EyeOff, LayoutDashboard, Search, Smartphone } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { GlobalSettings } from '../../../../shared/types'
import { DASHBOARD_BUCKET_ORDER, type DashboardBucket } from '../../../../shared/dashboard-snapshot'
import { useAgentBucketCounts } from '@/components/dashboard/useAgentBucketCounts'
import { useActivityUnreadCount } from '@/components/activity/useActivityUnreadCount'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useMobileSidebarOnboardingBadge } from './mobile-sidebar-onboarding-badge'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SetupGuideSidebarEntry } from './SetupGuideSidebarEntry'
import { SidebarTaskNavButton } from './SidebarTaskNavButton'
import { HideSidebarMenu } from './sidebar-nav-controls'
import { translate } from '@/i18n/i18n'

export { getSetupGuideSidebarEntryReady, shouldShowSetupGuideEntry } from './SetupGuideSidebarEntry'

export function shouldShowAgentsButton(
  settings: Pick<GlobalSettings, 'experimentalActivity'> | null | undefined
): boolean {
  return settings?.experimentalActivity === true
}

export function shouldShowAgentDashboardButton(
  settings: Pick<GlobalSettings, 'experimentalAgentDashboardPopout'> | null | undefined
): boolean {
  return settings?.experimentalAgentDashboardPopout === true
}

export function shouldShowMobileButton(
  settings: Pick<GlobalSettings, 'showMobileButton'> | null | undefined
): boolean {
  return settings?.showMobileButton !== false
}

export function shouldShowAutomationsButton(
  settings: Pick<GlobalSettings, 'showAutomationsButton'> | null | undefined
): boolean {
  return settings?.showAutomationsButton !== false
}

// Per-state dot colors mirror AgentStateDot so the sidebar counts read the same
// as the board (amber = needs you, yellow = working, neutral = idle, emerald = done).
const DASHBOARD_BUCKET_DOT_CLASS: Record<DashboardBucket, string> = {
  attention: 'bg-amber-500',
  working: 'bg-yellow-500',
  idle: 'bg-neutral-500/50'
}

function dashboardBucketLabel(bucket: DashboardBucket): string {
  switch (bucket) {
    case 'attention':
      return translate('dashboardPopout.bucket.attention', 'Needs You')
    case 'working':
      return translate('dashboardPopout.bucket.working', 'Working')
    case 'idle':
      return translate('dashboardPopout.bucket.idle', 'Idle')
  }
}

function DashboardBucketCounts({
  counts
}: {
  counts: Record<DashboardBucket, number>
}): React.JSX.Element | null {
  const active = DASHBOARD_BUCKET_ORDER.filter((bucket) => counts[bucket] > 0)
  if (active.length === 0) {
    return null
  }
  return (
    <span className="flex items-center gap-1.5">
      {active.map((bucket) => (
        <span
          key={bucket}
          aria-label={`${dashboardBucketLabel(bucket)}: ${counts[bucket]}`}
          className="inline-flex items-center gap-1 text-[10px] tabular-nums text-worktree-sidebar-foreground/55"
        >
          <span className={cn('size-1.5 rounded-full', DASHBOARD_BUCKET_DOT_CLASS[bucket])} />
          {counts[bucket]}
        </span>
      ))}
    </span>
  )
}

// Why: keep the dashboard's broad aggregate subscriptions out of SidebarNav so
// agent-status churn only updates this opt-in row, not the full navigation.
function AgentDashboardSidebarEntry(): React.JSX.Element {
  const dashboardBucketCounts = useAgentBucketCounts()

  return (
    <button
      type="button"
      onClick={() => {
        void window.api.dashboard.openPopout()
      }}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
        'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
      )}
    >
      <LayoutDashboard
        className="size-4 shrink-0 text-worktree-sidebar-foreground/30"
        strokeWidth={1.75}
      />
      <span className="flex-1">{translate('dashboard.sidebar.label', 'Agent Dashboard')}</span>
      <DashboardBucketCounts counts={dashboardBucketCounts} />
    </button>
  )
}

const SidebarNav = React.memo(function SidebarNav() {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  const worktreePaletteShortcutCombos = useShortcutKeyComboDetails('worktree.palette')
  const openAutomationsPage = useAppStore((s) => s.openAutomationsPage)
  const openActivityPage = useAppStore((s) => s.openActivityPage)
  const openMobilePage = useAppStore((s) => s.openMobilePage)
  const openModal = useAppStore((s) => s.openModal)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const activeView = useAppStore((s) => s.activeView)
  const showAgentsButton = useAppStore((s) => shouldShowAgentsButton(s.settings))
  const showAgentDashboardButton = useAppStore((s) => shouldShowAgentDashboardButton(s.settings))
  const showAutomationsButton = useAppStore((s) => shouldShowAutomationsButton(s.settings))
  const showMobileButton = useAppStore((s) => shouldShowMobileButton(s.settings))
  const automationsActive = activeView === 'automations'
  const activityActive = activeView === 'activity'
  const mobileActive = activeView === 'mobile'
  const activityUnreadCount = useActivityUnreadCount(showAgentsButton, 'sidebar-badge')
  const mobileOnboardingBadge = useMobileSidebarOnboardingBadge(showMobileButton)
  const hideAutomationsButton = React.useCallback(() => {
    void updateSettings({ showAutomationsButton: false })
  }, [updateSettings])
  const hideMobileButton = React.useCallback(() => {
    void updateSettings({ showMobileButton: false })
  }, [updateSettings])

  return (
    <div
      className="flex flex-col gap-0.5 px-2 pt-2 pb-1"
      data-contextual-tour-target="sidebar-navigation"
    >
      <SetupGuideSidebarEntry />
      <SidebarTaskNavButton />
      {showAutomationsButton ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              onClick={openAutomationsPage}
              aria-current={automationsActive ? 'page' : undefined}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
                automationsActive
                  ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
                  : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
              )}
            >
              <CalendarClock
                className={cn(
                  'size-4 shrink-0',
                  !automationsActive && 'text-worktree-sidebar-foreground/30'
                )}
                strokeWidth={automationsActive ? 2.25 : 1.75}
              />
              <span className="flex-1">
                {translate('auto.components.sidebar.SidebarNav.f323383e9a', 'Automations')}
              </span>
            </button>
          </ContextMenuTrigger>
          <HideSidebarMenu onHide={hideAutomationsButton} />
        </ContextMenu>
      ) : null}
      {showAgentDashboardButton ? <AgentDashboardSidebarEntry /> : null}
      {showAgentsButton ? (
        <button
          type="button"
          onClick={openActivityPage}
          aria-current={activityActive ? 'page' : undefined}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
            activityActive
              ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
              : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
          )}
        >
          <Bell
            className={cn(
              'size-4 shrink-0',
              !activityActive && 'text-worktree-sidebar-foreground/30'
            )}
            strokeWidth={activityActive ? 2.25 : 1.75}
          />
          <span className="flex-1">
            {translate('auto.components.sidebar.SidebarNav.9c95e1ce91', 'Agents')}
          </span>
          {activityUnreadCount > 0 ? (
            <span className="rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground">
              {activityUnreadCount}
            </span>
          ) : null}
        </button>
      ) : null}
      {showMobileButton ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              className={cn(
                'group flex w-full items-center rounded-md text-[13px] font-medium tracking-tight transition-colors',
                mobileActive
                  ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
                  : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
              )}
            >
              <button
                type="button"
                onClick={() => {
                  mobileOnboardingBadge.dismiss()
                  openMobilePage()
                }}
                aria-current={mobileActive ? 'page' : undefined}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left"
              >
                <Smartphone
                  className={cn(
                    'size-4 shrink-0',
                    !mobileActive && 'text-worktree-sidebar-foreground/30'
                  )}
                  strokeWidth={mobileActive ? 2.25 : 1.75}
                />
                <span className="min-w-0 flex-1 truncate">
                  {translate('auto.components.sidebar.SidebarNav.1b5c41caee', 'Orca Mobile')}
                </span>
                {mobileOnboardingBadge.visible ? (
                  <span className="shrink-0 rounded-full bg-primary px-1.5 py-px text-[10px] font-semibold text-primary-foreground">
                    {translate('auto.components.sidebar.SidebarNav.c86d83b5c3', 'New')}
                  </span>
                ) : null}
              </button>
              {mobileOnboardingBadge.hasPairedDevice ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className={cn(
                        'mr-1 text-worktree-sidebar-foreground/55 hover:bg-worktree-sidebar-foreground/10 hover:text-worktree-sidebar-foreground',
                        mobileActive &&
                          'text-worktree-sidebar-accent-foreground/70 hover:text-worktree-sidebar-accent-foreground'
                      )}
                      onClick={(event) => {
                        event.stopPropagation()
                        hideMobileButton()
                      }}
                      aria-label={translate(
                        'auto.components.sidebar.SidebarNav.d599269755',
                        'Hide from sidebar'
                      )}
                    >
                      <EyeOff className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    {translate(
                      'auto.components.sidebar.SidebarNav.d599269755',
                      'Hide from sidebar'
                    )}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          </ContextMenuTrigger>
          <HideSidebarMenu onHide={hideMobileButton} />
        </ContextMenu>
      ) : null}
      <button
        type="button"
        onClick={() => openModal('worktree-palette')}
        aria-label={translate(
          'auto.components.sidebar.SidebarNav.0c3395fd32',
          'Search worktrees and browser tabs'
        )}
        className="group relative flex h-7 w-full items-center rounded-md border border-worktree-sidebar-border/70 bg-worktree-sidebar-foreground/5 pl-7 pr-1.5 text-left text-[12px] font-medium tracking-tight text-worktree-sidebar-foreground/45 transition-colors hover:border-worktree-sidebar-border hover:bg-worktree-sidebar-foreground/8 hover:text-worktree-sidebar-foreground/60 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-worktree-sidebar-ring/50"
      >
        <Search
          className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-worktree-sidebar-foreground/30"
          strokeWidth={1.75}
        />
        <span className="min-w-0 flex-1 truncate">
          {translate('auto.components.sidebar.SidebarNav.80611a8b10', 'Search')}
        </span>
        <span className="pointer-events-none ml-1.5 hidden shrink-0 items-center gap-1.5 group-hover:inline-flex group-focus-within:inline-flex">
          {worktreePaletteShortcutCombos.map((combo) => (
            <ShortcutKeyCombo
              key={combo.keys.join('-')}
              keys={combo.keys}
              doubleTap={combo.doubleTap}
              className="inline-flex gap-0.5"
              keyCapClassName="min-w-4 border-worktree-sidebar-border/80 bg-worktree-sidebar-foreground/8 px-1 py-px text-[9px] text-worktree-sidebar-foreground/55 shadow-none"
              separatorClassName="text-[9px] text-worktree-sidebar-foreground/45"
            />
          ))}
        </span>
      </button>
    </div>
  )
})

export default SidebarNav
