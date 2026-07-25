import React from 'react'
import { Bell, CalendarClock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { useActivityUnreadCount } from '@/components/activity/useActivityUnreadCount'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { HideSidebarMenu } from './sidebar-nav-controls'
import { shouldShowAgentsButton, shouldShowAutomationsButton } from './SidebarNav'
import { translate } from '@/i18n/i18n'

/**
 * Why: Automations and Agents are workflow surfaces, not launch controls —
 * they read better below the Projects list (operator order: search →
 * projects → automations/agents → panels) while the top nav stays reserved
 * for setup, tasks, mobile, and search.
 */
const SidebarSecondaryNav = React.memo(function SidebarSecondaryNav() {
  // Why: this memo boundary needs its own language subscription, while
  // translate() preserves Orca's pseudo-localization behavior.
  useTranslation()
  const openAutomationsPage = useAppStore((s) => s.openAutomationsPage)
  const openActivityPage = useAppStore((s) => s.openActivityPage)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const activeView = useAppStore((s) => s.activeView)
  const showAgentsButton = useAppStore((s) => shouldShowAgentsButton(s.settings))
  const showAutomationsButton = useAppStore((s) => shouldShowAutomationsButton(s.settings))
  const automationsActive = activeView === 'automations'
  const activityActive = activeView === 'activity'
  const activityUnreadCount = useActivityUnreadCount(showAgentsButton, 'sidebar-badge')
  const hideAutomationsButton = React.useCallback(() => {
    void updateSettings({ showAutomationsButton: false })
  }, [updateSettings])

  if (!showAutomationsButton && !showAgentsButton) {
    return null
  }

  return (
    <div className="flex flex-col gap-0.5 px-2 pb-1">
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
    </div>
  )
})

export default SidebarSecondaryNav
