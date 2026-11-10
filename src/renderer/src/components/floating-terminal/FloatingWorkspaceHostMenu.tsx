import { useMemo } from 'react'
import { Server, TerminalSquare } from 'lucide-react'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useDetectedAgents, type AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import { useTranslate } from '@/i18n/use-translate'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { getExecutionHostHealthLabel } from '@/runtime/hosts/display/runtime-host-copy'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { orderAgentLaunchPickerAgents } from '../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host/execution-host-registry'
import type { ExecutionHostRegistryEntry } from '../../../../shared/execution-host/execution-host-registry-entry'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'

type FloatingWorkspaceHostMenuActions = {
  onNewTerminal: (hostId: ExecutionHostId) => void
  onLaunchAgent: (agent: TuiAgent, hostId: ExecutionHostId) => void
}

/**
 * The paired Orca servers a floating tab can open on, whichever server the app is focused on. A
 * directly dialed SSH host is left out: it has no floating directory of its own to start in.
 */
export function floatingWorkspaceRemoteHosts(
  state: Pick<AppState, 'runtimeEnvironments' | 'runtimeStatusByEnvironmentId' | 'settings'>
): ExecutionHostRegistryEntry[] {
  return buildExecutionHostRegistry({
    repos: [],
    settings: null,
    hostSource: 'configured-only',
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
    hostLabelOverrides: getHostDisplayLabelOverrides(state.settings)
  }).filter((host) => host.kind === 'runtime')
}

/** Rows closing the floating "+" menu: one submenu per paired server. Mounted only while it is open. */
export function FloatingWorkspaceHostMenu(
  actions: FloatingWorkspaceHostMenuActions
): React.JSX.Element | null {
  const t = useTranslate()
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const runtimeStatusByEnvironmentId = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  const settings = useAppStore((state) => state.settings)
  const hosts = useMemo(
    () =>
      floatingWorkspaceRemoteHosts({ runtimeEnvironments, runtimeStatusByEnvironmentId, settings }),
    [runtimeEnvironments, runtimeStatusByEnvironmentId, settings]
  )
  if (hosts.length === 0) {
    return null
  }
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>
        {t(
          'auto.components.floating.terminal.FloatingWorkspaceHostMenu.heading',
          'Open on another host'
        )}
      </DropdownMenuLabel>
      {hosts.map((host) => {
        const available = host.health === 'available'
        return (
          <DropdownMenuSub key={host.id}>
            <DropdownMenuSubTrigger disabled={!available} title={host.label}>
              <Server />
              <span className="min-w-0 flex-1 truncate">{host.label}</span>
              {available ? null : (
                <DropdownMenuShortcut>
                  {getExecutionHostHealthLabel(host.health, host.blockedReason, t, host.vmState)}
                </DropdownMenuShortcut>
              )}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              <FloatingWorkspaceHostItems hostId={host.id} {...actions} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )
      })}
    </>
  )
}

/** Mounted on hover, so a server's agents are only listed once its submenu opens. */
function FloatingWorkspaceHostItems({
  hostId,
  onNewTerminal,
  onLaunchAgent
}: FloatingWorkspaceHostMenuActions & { hostId: ExecutionHostId }): React.JSX.Element {
  const t = useTranslate()
  const host = parseExecutionHostId(hostId)
  const environmentId = host?.kind === 'runtime' ? host.environmentId : null
  const target = useMemo<AgentDetectionTarget | undefined>(
    () => (environmentId ? { kind: 'runtime', environmentId } : undefined),
    [environmentId]
  )
  const { detectedIds, isLoading } = useDetectedAgents(target)
  const defaultAgent = useAppStore((state) => state.settings?.defaultTuiAgent)
  const disabledAgents = useAppStore((state) => state.settings?.disabledTuiAgents)
  const agents = orderAgentLaunchPickerAgents(defaultAgent, detectedIds ?? [], disabledAgents)
  return (
    <>
      <DropdownMenuItem onSelect={() => onNewTerminal(hostId)}>
        <TerminalSquare />
        {t('auto.components.tab.bar.TabBar.d364f3c8d4', 'New Terminal')}
      </DropdownMenuItem>
      {agents.length > 0 ? <DropdownMenuSeparator /> : null}
      {agents.map((agent) => (
        <DropdownMenuItem key={agent} onSelect={() => onLaunchAgent(agent, hostId)}>
          <AgentIcon agent={agent} size={14} />
          <span className="min-w-0 flex-1 truncate">
            {getAgentCatalog().find((entry) => entry.id === agent)?.label ?? agent}
          </span>
        </DropdownMenuItem>
      ))}
      {detectedIds === null && isLoading ? (
        <DropdownMenuItem disabled>
          {t('auto.components.tab.bar.QuickLaunchButton.agentsLoading', 'Loading agents')}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}
