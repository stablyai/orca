import type { AgentSessionMcpServer, AgentSessionMcpSignIn } from '../agent-session-mcp'

export type AgentSessionMcpServerGroup = {
  /** null for an agent that reports no source; its servers show without a heading. */
  source: string | null
  servers: AgentSessionMcpServer[]
}

/** Groups keep the order the agent listed their first server in. */
export function groupAgentSessionMcpServers(
  servers: readonly AgentSessionMcpServer[]
): AgentSessionMcpServerGroup[] {
  const groups = new Map<string | null, AgentSessionMcpServerGroup>()
  for (const server of servers) {
    const group = groups.get(server.source)
    if (group) {
      group.servers.push(server)
    } else {
      groups.set(server.source, { source: server.source, servers: [server] })
    }
  }
  return [...groups.values()]
}

const CLAUDE_AI_PREFIX = 'claude.ai '

/** claude.ai connectors already sit under a claude.ai heading. */
export function agentSessionMcpServerDisplayName(server: AgentSessionMcpServer): string {
  return server.source === 'claudeai' &&
    server.name.startsWith(CLAUDE_AI_PREFIX) &&
    server.name.length > CLAUDE_AI_PREFIX.length
    ? server.name.slice(CLAUDE_AI_PREFIX.length)
    : server.name
}

export type AgentSessionMcpRowFailure =
  | { kind: 'signInUnfinished' }
  | { kind: 'message'; message: string | null }

/** What a row shows for its last refused action, if anything. */
export function agentSessionMcpRowFailure(
  server: AgentSessionMcpServer,
  failure: { server: string; message: string | null } | null,
  signIn: AgentSessionMcpSignIn | null
): AgentSessionMcpRowFailure | null {
  if (failure?.server !== server.name) {
    return null
  }
  // The provider refuses a reconnect until its own site finishes the sign-in.
  if (signIn?.server === server.name && signIn.finish === 'external') {
    return { kind: 'signInUnfinished' }
  }
  // The status line already says why the server failed.
  return failure.message !== null && failure.message === server.error
    ? null
    : { kind: 'message', message: failure.message }
}
