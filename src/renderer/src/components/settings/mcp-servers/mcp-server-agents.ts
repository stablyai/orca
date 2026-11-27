// Which of the host's agents a server can be turned on for: the installed ones Orca gives servers to.
import { useMemo } from 'react'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  MCP_FILE_AGENTS,
  type McpFileAgent,
  type McpServer
} from '../../../../../shared/mcp-servers/mcp-servers'
import { useDetectedAgents } from '@/lib/agent-session/launch/inventory/useDetectedAgents'
import { useRuntimeHostStatusViewSelector } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { isMacUserAgent, isWindowsUserAgent } from '@/app-shell/platform/user-agent-platform'

/** The agents Orca delivers servers to, in the order the server page lists them. */
const MCP_SERVER_AGENTS: readonly TuiAgent[] = [
  'claude',
  'codex',
  'opencode',
  'copilot',
  'pi',
  'amp',
  'grok',
  'cursor',
  'droid'
]

/** The host's installed agents a server can be on for; null until the host has listed them. */
export function useMcpServerAgents(target: RuntimeClientTarget): TuiAgent[] | null {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const detection = useMemo(
    () =>
      environmentId === null
        ? { kind: 'local' as const }
        : { kind: 'runtime' as const, environmentId },
    [environmentId]
  )
  const { detectedIds } = useDetectedAgents(detection, 'all')
  return useMemo(
    () => (detectedIds ? MCP_SERVER_AGENTS.filter((agent) => detectedIds.includes(agent)) : null),
    [detectedIds]
  )
}

/** The agents a server is on for, out of `agents`. */
export function mcpServerAgentsOn(server: McpServer, agents: readonly string[]): string[] {
  return agents.filter((agent) => !server.agentsOff.includes(agent))
}

export function isMcpFileAgent(agent: string): agent is McpFileAgent {
  return MCP_FILE_AGENTS.some((entry) => entry === agent)
}

/** The host's platform, for the editor's checks; this computer's until a server says its own. */
export function useMcpHostPlatform(target: RuntimeClientTarget): NodeJS.Platform {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const remote = useRuntimeHostStatusViewSelector(
    environmentId,
    (entry) => entry?.status?.hostPlatform ?? null
  )
  return remote ?? (isWindowsUserAgent() ? 'win32' : isMacUserAgent() ? 'darwin' : 'linux')
}
