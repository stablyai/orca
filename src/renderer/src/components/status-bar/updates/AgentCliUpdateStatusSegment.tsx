import { useEffect, useMemo } from 'react'
import { AlertCircle, Download, Loader2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { agentCliUpdateHostTarget } from '@/store/slices/runtime-host-updates/agent-cli-updates'
import {
  AgentCliUpdateList,
  agentCliUpdateRows,
  agentCliUpdateStartable,
  type AgentCliUpdateGroup,
  type AgentCliUpdateRow
} from './AgentCliUpdateList'

const LOCAL_TARGET = { kind: 'local' } as const

function runRow(row: AgentCliUpdateRow): void {
  void useAppStore.getState().runAgentCliUpdate(agentCliUpdateHostTarget(row.hostKey), row.agent)
}

/** Shown while the user's own Claude Code or Codex CLI on a host has a newer release out. */
export function AgentCliUpdateStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const hosts = useAppStore((s) => s.agentCliUpdates)
  const hostNames = useAppStore(
    useShallow((s) =>
      Object.fromEntries(
        s.runtimeEnvironments.map((environment) => [environment.id, environment.name])
      )
    )
  )
  const checkAgentCliUpdates = useAppStore((s) => s.checkAgentCliUpdates)
  // This computer is checked at launch; other hosts when a chat starts there.
  useEffect(() => {
    void checkAgentCliUpdates(LOCAL_TARGET)
  }, [checkAgentCliUpdates])

  const groups = useMemo((): AgentCliUpdateGroup[] => {
    const listed = [...hosts]
      .map(([hostKey, host]) => ({ hostKey, rows: agentCliUpdateRows(hostKey, host) }))
      .filter((group) => group.rows.length > 0)
      .sort((a, b) => (a.hostKey === '' ? -1 : b.hostKey === '' ? 1 : 0))
    const remote = listed.some((group) => group.hostKey !== '')
    return listed.map((group) => ({
      ...group,
      label: !remote
        ? null
        : group.hostKey === ''
          ? t('agentCliUpdate.thisComputer', 'This computer')
          : (hostNames[group.hostKey] ?? group.hostKey)
    }))
  }, [hosts, hostNames, t])

  const rows = groups.flatMap((group) => group.rows)
  if (rows.length === 0) {
    return null
  }
  const busy = rows.some((row) => row.run?.phase === 'running')
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
          label:
            rows.length === 1
              ? t('agentCliUpdate.statusOne', 'CLI update')
              : t('agentCliUpdate.statusCount', '{{count}} CLI updates', { count: rows.length }),
          tooltip: t('agentCliUpdate.statusTooltip', 'Newer agent CLI versions are out')
        }

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/70"
              aria-label={iconOnly ? segment.label : undefined}
            >
              {segment.icon}
              {!iconOnly ? <span className="text-2xs tabular-nums">{segment.label}</span> : null}
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
          onUpdate={runRow}
          onUpdateAll={() => rows.filter(agentCliUpdateStartable).forEach(runRow)}
        />
      </PopoverContent>
    </Popover>
  )
}
