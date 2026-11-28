import { AlertCircle, Download, Loader2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { agentCliUpdateHostTarget } from '@/store/slices/runtime-host-updates/agent-cli-updates'
import { useAgentCliUpdateGroups } from '@/components/agent-cli-update/use-agent-cli-update-groups'
import {
  agentCliUpdateBusy,
  agentCliUpdateStartable
} from '../../../../../shared/agent-launch/installation/agent-cli-update-runs'
import {
  AgentCliUpdateList,
  runAgentCliUpdateRow,
  type AgentCliUpdateGroup
} from './AgentCliUpdateList'

// A CLI the user updated in a terminal clears once its host is asked again.
function checkGroupsOnOpen(open: boolean, groups: readonly AgentCliUpdateGroup[]): void {
  if (!open) {
    return
  }
  const { checkAgentCliUpdatesOnOpen } = useAppStore.getState()
  for (const group of groups) {
    void checkAgentCliUpdatesOnOpen(agentCliUpdateHostTarget(group.hostKey))
  }
}

/** Shown while the user's own Claude Code or Codex CLI on a host has a newer release out. */
export function AgentCliUpdateStatusSegment(): React.JSX.Element | null {
  const t = useTranslate()
  const groups = useAgentCliUpdateGroups()

  const rows = groups.flatMap((group) => group.rows)
  if (rows.length === 0) {
    return null
  }
  const busy = rows.some(agentCliUpdateBusy)
  const failed = rows.some((row) => row.run?.phase === 'failed')
  const segment = busy
    ? {
        icon: <Loader2 className="size-3 animate-spin text-muted-foreground" />,
        label: t('agentCliUpdate.statusUpdating', 'Updating CLIs'),
        tooltip: t('agentCliUpdate.statusUpdatingTooltip', 'Agent CLI updates are running')
      }
    : failed
      ? {
          icon: <AlertCircle className="size-3 text-destructive" />,
          label: t('agentCliUpdate.statusFailed', 'CLI update failed'),
          tooltip: t('agentCliUpdate.statusFailedTooltip', 'Open to see what went wrong')
        }
      : {
          icon: <Download className="size-3 text-muted-foreground" />,
          label: t('agentCliUpdate.statusCount', '{{count}} CLI updates', {
            count: rows.length,
            defaultValue_one: '{{count}} CLI update'
          }),
          tooltip: t('agentCliUpdate.statusTooltip', 'Newer agent CLI versions are out')
        }

  return (
    <Popover onOpenChange={(open) => checkGroupsOnOpen(open, groups)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/70"
            >
              {segment.icon}
              <span className="text-2xs tabular-nums">{segment.label}</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {segment.tooltip}
        </TooltipContent>
      </Tooltip>
      <PopoverContent side="top" align="end" sideOffset={6} className="w-80">
        <AgentCliUpdateList
          groups={groups}
          onUpdate={runAgentCliUpdateRow}
          onUpdateAll={() => rows.filter(agentCliUpdateStartable).forEach(runAgentCliUpdateRow)}
        />
      </PopoverContent>
    </Popover>
  )
}
