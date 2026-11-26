import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { MCP_SERVERS_RUNTIME_CAPABILITY } from '../../../../../shared/mcp-servers/mcp-servers'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

const LOCAL: RuntimeClientTarget = { kind: 'local' }

/**
 * Settings lists MCP servers once this computer, the default host or the host Settings picked serves
 * them (`mcp-servers.v1`).
 */
export function useMcpServersAvailable(
  defaultHost: RuntimeClientTarget,
  pickedHost?: RuntimeClientTarget
): boolean {
  const local = useStructuredAgentSessionHostCapabilityState(LOCAL, MCP_SERVERS_RUNTIME_CAPABILITY)
  const host = useStructuredAgentSessionHostCapabilityState(
    defaultHost.kind === 'environment' ? defaultHost : null,
    MCP_SERVERS_RUNTIME_CAPABILITY
  )
  const picked = useStructuredAgentSessionHostCapabilityState(
    pickedHost?.kind === 'environment' ? pickedHost : null,
    MCP_SERVERS_RUNTIME_CAPABILITY
  )
  return local === 'supported' || host === 'supported' || picked === 'supported'
}
