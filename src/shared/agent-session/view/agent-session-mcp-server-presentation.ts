import type {
  AgentSessionMcpServer,
  AgentSessionMcpSignIn
} from '../options/protocol/agent-session-mcp'
import type { AgentSessionMcpFailure } from './use-agent-session-mcp-panel'

export type AgentSessionMcpServerGroup = {
  /** null for an agent that reports no source; its servers show without a heading. */
  source: string | null
  servers: AgentSessionMcpServer[]
}

/** Servers Orca added from the host's list (`withOrcaMcpSource` on the host). */
export const ORCA_MCP_SOURCE = 'orca'

/** Orca's group comes first; the others keep the order the agent listed their first server in. */
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
  const orca = groups.get(ORCA_MCP_SOURCE)
  return orca
    ? [orca, ...[...groups.values()].filter((group) => group !== orca)]
    : [...groups.values()]
}

/** The status a row's dot and the tray's counts show: one Orca removed is neither failing nor
 *  waiting for a sign-in, only gone after the next message. */
export function agentSessionMcpShownStatus(
  server: AgentSessionMcpServer
): AgentSessionMcpServer['status'] {
  return server.orcaChange === 'removed' ? 'not-started' : server.status
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
  /** A reconnect left it failing for the reason its status line already gives. */
  | { kind: 'stillFailing' }
  | { kind: 'message'; message: string | null }

/** What a row shows for its last refused action, if anything. */
export function agentSessionMcpRowFailure(
  server: AgentSessionMcpServer,
  failure: AgentSessionMcpFailure | null,
  signIn: AgentSessionMcpSignIn | null
): AgentSessionMcpRowFailure | null {
  if (failure?.server !== server.name) {
    return null
  }
  // The provider refuses a reconnect until its own site finishes the sign-in.
  if (signIn?.server === server.name && signIn.finish === 'external') {
    return { kind: 'signInUnfinished' }
  }
  if (failure.stillFailing) {
    // A server that recovered since says nothing; one failing for a new reason shows it.
    if (agentSessionMcpShownStatus(server) !== 'failed') {
      return null
    }
    if (failure.message === null || failure.message === server.error) {
      return { kind: 'stillFailing' }
    }
  }
  // The status line already says why the server failed.
  return failure.message !== null && failure.message === server.error
    ? null
    : { kind: 'message', message: failure.message }
}

/** The ids of an at-rest chat's Orca servers its client can check before the agent starts, as
 *  one key (empty when there are none). */
export function uncheckedOrcaMcpServerIds(servers: readonly AgentSessionMcpServer[]): string {
  return servers
    .flatMap((server) => (server.orca && server.status === 'not-started' ? [server.orca.id] : []))
    .sort()
    .join(',')
}

/** Names one problems check, so cancelling it leaves the window's other checks running. */
export function newMcpProblemsRequestId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** Orca's check of its host list (`mcpServers.problems`, by server id) on an at-rest chat's rows.
 *  The check signs in as Claude Code or Codex, so only their chats take its sign-in verdict. */
export function withOrcaMcpProblems(
  servers: readonly AgentSessionMcpServer[],
  problems: Readonly<Record<string, { kind: 'sign-in' | 'failed' | 'unconfirmed' }>>,
  agent: string
): readonly AgentSessionMcpServer[] {
  if (Object.keys(problems).length === 0) {
    return servers
  }
  return servers.map((server) => {
    const problem = server.orca && server.status === 'not-started' && problems[server.orca.id]
    // Orca's own sign-in state is the truth for a server it signs in to, as in its settings.
    const notTheirs = server.orca?.signsIn || (agent !== 'claude' && agent !== 'codex')
    return !problem || problem.kind === 'unconfirmed' || (problem.kind === 'sign-in' && notTheirs)
      ? server
      : { ...server, status: problem.kind === 'sign-in' ? 'needs-auth' : 'failed' }
  })
}
