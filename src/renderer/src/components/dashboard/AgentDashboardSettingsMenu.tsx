import { Settings } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SettingsSegmentedControl } from '../settings/SettingsFormControls'
import type { AgentDashboardMode } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

type AgentDashboardSettingsMenuProps = {
  /** Called after the mode switches to pop-out so the host can hand the board
   *  over to the pop-out window instead of leaving a stale in-window board. */
  onSwitchToPopout: () => void
  /** Lets the host keep the companion board open while this menu owns the
   *  next outside click, matching the workspace board's menu handling. */
  onOpenChange: (open: boolean) => void
}

/** Board-header settings for the in-window Agent Dashboard, mirroring the
 *  workspace board's settings menu. In-window only — the pop-out renderer has
 *  no store access, so it never mounts this. */
export function AgentDashboardSettingsMenu({
  onSwitchToPopout,
  onOpenChange
}: AgentDashboardSettingsMenuProps): React.JSX.Element {
  const mode = useAppStore((s) => s.settings?.experimentalAgentDashboardMode ?? 'in-window')
  const updateSettings = useAppStore((s) => s.updateSettings)

  const handleModeChange = (next: AgentDashboardMode): void => {
    if (next === mode) {
      return
    }
    updateSettings({ experimentalAgentDashboardMode: next })
    if (next === 'popout') {
      onSwitchToPopout()
    }
  }

  return (
    <DropdownMenu modal={false} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={translate('dashboardPopout.settings', 'Agent Dashboard settings')}
              className="text-muted-foreground"
            >
              <Settings className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {translate('dashboardPopout.settingsTooltip', 'Board settings')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" sideOffset={8} collisionPadding={8} className="w-72 p-2">
        <div className="flex items-start justify-between gap-3 rounded-md px-1.5 py-1.5">
          <span className="min-w-0 space-y-0.5">
            <span className="block text-[12px] font-medium leading-4 text-foreground">
              {translate(
                'auto.components.settings.ExperimentalPane.agentDashboard.modeLabel',
                'Open as'
              )}
            </span>
            <span className="block text-[11px] leading-4 text-muted-foreground">
              {translate(
                'auto.components.settings.ExperimentalPane.agentDashboard.modeCopy',
                'Show the dashboard as an in-window board beside the sidebar or a separate pop-out window.'
              )}
            </span>
          </span>
        </div>
        <div className="px-1.5 pb-1">
          <SettingsSegmentedControl
            value={mode}
            onChange={handleModeChange}
            ariaLabel={translate(
              'auto.components.settings.ExperimentalPane.agentDashboard.modeAriaLabel',
              'Agent Dashboard open mode'
            )}
            size="sm"
            equalWidth
            options={[
              {
                value: 'in-window',
                label: translate(
                  'auto.components.settings.ExperimentalPane.agentDashboard.modeInWindow',
                  'In-window'
                )
              },
              {
                value: 'popout',
                label: translate(
                  'auto.components.settings.ExperimentalPane.agentDashboard.modePopout',
                  'Pop-out'
                )
              }
            ]}
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
