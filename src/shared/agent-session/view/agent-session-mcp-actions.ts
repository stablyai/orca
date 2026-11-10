import type { AgentSessionMcpAction, AgentSessionMcpServer } from '../agent-session-mcp'

export function primaryAgentSessionMcpAction(
  server: AgentSessionMcpServer
): AgentSessionMcpAction | null {
  if (server.status === 'disabled') {
    return { action: 'toggle', server: server.name, enabled: true }
  }
  if (server.status === 'needs-auth' && server.canAuthenticate) {
    return { action: 'authenticate', server: server.name }
  }
  if (server.status === 'failed') {
    return { action: 'reconnect', server: server.name }
  }
  return null
}
