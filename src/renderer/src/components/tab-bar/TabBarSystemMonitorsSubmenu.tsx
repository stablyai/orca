import React from 'react'
import { Activity } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import {
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import type { SystemMonitorDescriptor } from '../../../../shared/system-monitors'

export function TabBarSystemMonitorsSubmenu({
  monitors,
  onLaunchMonitor
}: {
  monitors: readonly SystemMonitorDescriptor[]
  onLaunchMonitor: (monitor: SystemMonitorDescriptor) => void
}): React.JSX.Element | null {
  if (monitors.length === 0) {
    return null
  }
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium">
        <Activity className="size-4 text-muted-foreground" />
        <span className="flex-1">
          {translate('auto.components.tab.bar.TabBar.systemMonitors', 'Monitors')}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56">
        {monitors.map((monitor) => (
          <DropdownMenuItem
            key={monitor.id}
            onSelect={() => onLaunchMonitor(monitor)}
            className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
          >
            <Activity className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{monitor.label}</span>
            <DropdownMenuShortcut className="shrink-0">{monitor.categoryLabel}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
