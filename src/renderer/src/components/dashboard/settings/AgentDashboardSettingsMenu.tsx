import { Settings } from 'lucide-react'
import { useAppStore } from '@/store/index'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SettingsSegmentedControl } from '../../settings/form-controls/SettingsFormControls'
import { Switch } from '@/components/ui/switch'
import type { AgentDashboardMode } from '../../../../../shared/ui-chrome/ui-chrome-types'
import { useTranslate } from '@/i18n/use-translate'
import { canOpenAgentDashboardPopout, resolveAgentDashboardMode } from './agent-dashboard-open-mode'

type AgentDashboardSettingsMenuProps = {
  /** Hand off to the pop-out after switching modes so the old drawer does not remain. */
  onSwitchToPopout: () => void
  /** Let the host reserve the next outside click for menu dismissal, matching the workspace board. */
  onOpenChange: (open: boolean) => void
}

/** In-window settings only; pop-out renderers have no store access. */
export function AgentDashboardSettingsMenu({
  onSwitchToPopout,
  onOpenChange
}: AgentDashboardSettingsMenuProps): React.JSX.Element {
  const t = useTranslate()
  const mode = useAppStore((s) => resolveAgentDashboardMode(s.settings))
  const showIdle = useAppStore((s) => s.settings?.experimentalAgentDashboardShowIdle === true)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const handleModeChange = (next: AgentDashboardMode): void => {
    if (next === mode) {
      return
    }
    const saved = updateSettings({ experimentalAgentDashboardMode: next })
    if (next === 'popout') {
      onSwitchToPopout()
      return
    }
    // Move the open board to the new host once the mode is in the store; earlier, Sidebar still sees the
    // old mode and closes the drawer we just opened.
    void saved.then(() => {
      const state = useAppStore.getState()
      if (next === 'right-sidebar') {
        state.setAgentDashboardDrawerOpen(false)
        state.setRightSidebarTab('agent-dashboard')
        state.setRightSidebarOpen(true)
      } else {
        state.setSidebarOpen(true)
        state.setAgentDashboardDrawerOpen(true)
      }
    })
  }

  return (
    <DropdownMenu modal={false} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('dashboardPopout.settingsLabel', 'Agent Dashboard settings')}
              className="text-muted-foreground"
            >
              <Settings className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {t('dashboardPopout.settingsTooltip', 'Board settings')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" sideOffset={8} collisionPadding={8} className="w-72 p-2">
        {/* A web client still chooses between the in-window board and the right sidebar; only pop-out needs a window. */}
        <>
          <div className="flex items-start justify-between gap-3 rounded-md px-1.5 py-1.5">
            <span className="min-w-0 space-y-0.5">
              <span className="block text-[12px] font-medium leading-4 text-foreground">
                {t('auto.components.settings.ExperimentalPane.agentDashboard.modeLabel', 'Open as')}
              </span>
              <span className="block text-[11px] leading-4 text-muted-foreground">
                {t(
                  'auto.components.settings.ExperimentalPane.agentDashboard.modeCopy',
                  'Show the dashboard as an in-window board beside the sidebar, a separate pop-out window, or a right sidebar tab beside your work.'
                )}
              </span>
            </span>
          </div>
          <div className="px-1.5 pb-1">
            <SettingsSegmentedControl
              value={mode}
              onChange={handleModeChange}
              ariaLabel={t(
                'auto.components.settings.ExperimentalPane.agentDashboard.modeAriaLabel',
                'Agent Dashboard open mode'
              )}
              size="sm"
              options={[
                {
                  value: 'in-window' as const,
                  label: t(
                    'auto.components.settings.ExperimentalPane.agentDashboard.modeInWindow',
                    'In-window'
                  )
                },
                {
                  value: 'popout' as const,
                  label: t(
                    'auto.components.settings.ExperimentalPane.agentDashboard.modePopout',
                    'Pop-out'
                  )
                },
                {
                  value: 'right-sidebar' as const,
                  label: t(
                    'auto.components.settings.ExperimentalPane.agentDashboard.modeRightSidebar',
                    'Right sidebar'
                  )
                }
              ].filter((option) => option.value !== 'popout' || canOpenAgentDashboardPopout())}
            />
          </div>
          <DropdownMenuSeparator />
        </>
        <div className="flex items-start justify-between gap-3 rounded-md px-1.5 py-1.5">
          <span className="min-w-0 space-y-0.5">
            <span className="block text-[12px] font-medium leading-4 text-foreground">
              {t('dashboardPopout.settings.showIdle', 'Show idle agents')}
            </span>
            <span className="block text-[11px] leading-4 text-muted-foreground">
              {t(
                'dashboardPopout.settings.showIdleCopy',
                'Include agents that have gone quiet for 30 minutes without reporting completion. Hidden by default.'
              )}
            </span>
          </span>
          <Switch
            checked={showIdle}
            onCheckedChange={() => {
              void updateSettings({
                experimentalAgentDashboardShowIdle: !showIdle
              })
            }}
            aria-label={t('dashboardPopout.settings.showIdle', 'Show idle agents')}
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
