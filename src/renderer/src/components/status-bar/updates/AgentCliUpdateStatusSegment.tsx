import { useMemo } from 'react'
import { AlertCircle, Download, Loader2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { useTranslate } from '@/i18n/use-translate'
import { agentCliUpdateHostTarget } from '@/store/slices/runtime-host-updates/agent-cli-updates'
import {
  AgentCliUpdateList,
  agentCliUpdateRows,
  agentCliUpdateStartable,
  type AgentCliUpdateGroup,
  type AgentCliUpdateRow
} from './AgentCliUpdateList'

const NO_HOST_NAMES: Readonly<Record<string, string>> = Object.freeze({})

/** Names of paired servers with listed updates; the shared empty value keeps the always-mounted bar still. */
function remoteHostNames(state: AppState): Readonly<Record<string, string>> {
  const keys = [...state.agentCliUpdates.keys()].filter((key) => key !== '')
  if (keys.length === 0) {
    return NO_HOST_NAMES
  }
  return Object.fromEntries(
    keys.map((key) => [
      key,
      state.runtimeEnvironments.find((environment) => environment.id === key)?.name ?? key
    ])
  )
}

function runRow(row: AgentCliUpdateRow): void {
  void useAppStore.getState().runAgentCliUpdate(agentCliUpdateHostTarget(row.hostKey), row.agent)
}

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
  const hosts = useAppStore((s) => s.agentCliUpdates)
  const hostNames = useAppStore(useShallow(remoteHostNames))
  const hasOtherHosts = useAppStore(
    (s) => !isPairedWebClientWindow() && s.runtimeEnvironments.length > 0
  )

  const groups = useMemo((): AgentCliUpdateGroup[] => {
    const listed = [...hosts]
      .map(([hostKey, host]) => ({ hostKey, rows: agentCliUpdateRows(hostKey, host) }))
      .filter((group) => group.rows.length > 0)
      .sort((a, b) => (a.hostKey === '' ? -1 : b.hostKey === '' ? 1 : 0))
    // With any other host added (server, WSL host or VM), a local-only list still names this computer.
    const showHostHeadings = hasOtherHosts || listed.some((group) => group.hostKey !== '')
    return listed.map((group) => ({
      ...group,
      label: !showHostHeadings
        ? null
        : group.hostKey === ''
          ? t('agentCliUpdate.thisComputer', 'This computer')
          : (hostNames[group.hostKey] ?? group.hostKey)
    }))
  }, [hosts, hostNames, hasOtherHosts, t])

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
          onUpdate={runRow}
          onUpdateAll={() => rows.filter(agentCliUpdateStartable).forEach(runRow)}
        />
      </PopoverContent>
    </Popover>
  )
}
