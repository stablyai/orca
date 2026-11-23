import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { useAppStore } from '@/store/index'
import type { NewTabAgentMenuRow } from '../../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { customAgentMenuRow, launchableCustomAgents } from './custom-agent-menu-rows'

export function CustomAgentMenuItems({
  rows,
  detectedIds,
  disabled,
  runLaunch
}: {
  rows: readonly NewTabAgentMenuRow[]
  detectedIds: readonly TuiAgent[] | null
  disabled: boolean
  runLaunch: (row: NewTabAgentMenuRow) => unknown
}): React.JSX.Element | null {
  const customAgents = useAppStore((state) => state.settings?.customTuiAgents)
  const launchable = launchableCustomAgents(customAgents, detectedIds, rows)
  if (launchable.length === 0) {
    return null
  }
  return (
    <>
      <DropdownMenuSeparator />
      {launchable.map((custom) => (
        <DropdownMenuItem
          key={custom.id}
          variant="launch"
          disabled={disabled}
          title={custom.command}
          onSelect={() => runLaunch(customAgentMenuRow(custom, rows))}
        >
          <AgentIcon agent={custom.agent} size={14} />
          <span className="min-w-0 flex-1 truncate">{custom.name}</span>
          <span className="max-w-32 truncate font-mono text-xs font-normal text-muted-foreground">
            {custom.command}
          </span>
        </DropdownMenuItem>
      ))}
    </>
  )
}
