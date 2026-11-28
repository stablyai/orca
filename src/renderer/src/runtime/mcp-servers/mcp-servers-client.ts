// A host's MCP server list (`mcpServers.*`), read and changed on the host Settings has picked.
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { BotToolDetails, BotToolInput, BotToolProblem } from '../../../../shared/bot-tools'
import type { BotToolSignInAttemptView } from '../../../../shared/bot-tool-sign-in'
import type {
  DiscoveredMcpServer,
  McpAgentFiles,
  McpFileAgent,
  McpServer,
  McpServerWorkspaces
} from '../../../../shared/mcp-servers/mcp-servers'
import {
  emitMcpServersChangedWindowEvent,
  onMcpServersChanged
} from '@/lib/mcp-servers-changed-window-event'
import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'
import { getRuntimeTargetHostId } from '../rpc/targets/runtime-client-target'
import { RuntimeRpcCallError } from '../rpc/calls/runtime-rpc-result'

/** A server as a later host may send it: `plugin` names the plugin that contributes it. */
export type McpServerView = McpServer & { plugin?: { key: string; name: string } }

/** Why an agent gets none of the host's servers, whatever each server says. */
export type McpAgentProblem = { kind: 'blocked' | 'terminal-off'; detail: string }

export type McpServerList = {
  servers: McpServerView[]
  agentFiles: McpAgentFiles
  agentProblems?: Record<string, McpAgentProblem>
}

export type McpServerDetails = BotToolDetails & { id: string }

/** A method this host declares but doesn't serve yet, or one it doesn't know at all. */
export function isMcpMethodMissing(error: unknown): boolean {
  return (
    error instanceof RuntimeRpcCallError &&
    (error.code === 'mcp_servers_not_yet' || error.code === 'method_not_found')
  )
}

/** A method's params, checked by the host against its contract. */
type McpCallParams = Readonly<Record<string, unknown>>

function call<T>(
  target: RuntimeClientTarget,
  method: string,
  params: McpCallParams = {}
): Promise<T> {
  return callRuntimeRpc<T>(target, `mcpServers.${method}`, params)
}

/**
 * The host tells every client of a write (mcpServersChanged), but a change that writes nothing (a
 * stale view's switch already set there) tells none: then the asking window re-reads its list itself.
 */
async function change<T>(
  target: RuntimeClientTarget,
  method: string,
  params: McpCallParams = {}
): Promise<T> {
  const hostId = getRuntimeTargetHostId(target)
  let told = false
  const stop = onMcpServersChanged(() => {
    told = true
  }, hostId)
  try {
    const result = await call<T>(target, method, params)
    if (!told) {
      emitMcpServersChangedWindowEvent(hostId)
    }
    return result
  } finally {
    stop()
  }
}

const served = (server: { server: McpServerView }): McpServerView => server.server

export function readMcpServerList(target: RuntimeClientTarget): Promise<McpServerList> {
  return call(target, 'list')
}

/** Servers set up in the host's agents; none from a host that can't look yet. */
export async function discoverMcpServers(
  target: RuntimeClientTarget
): Promise<DiscoveredMcpServer[]> {
  try {
    return (await call<{ servers: DiscoveredMcpServer[] }>(target, 'discover')).servers
  } catch (error) {
    if (isMcpMethodMissing(error)) {
      return []
    }
    throw error
  }
}

export async function addMcpServer(
  target: RuntimeClientTarget,
  params: ({ source: string; name?: string } | { config: BotToolInput }) & {
    /** Where it's on from the start, written with it; all workspaces without it. */
    workspaces?: McpServerWorkspaces
  }
): Promise<McpServerView> {
  return served(await change(target, 'add', params))
}

export function readMcpServerDetails(
  target: RuntimeClientTarget,
  id: string
): Promise<McpServerDetails> {
  return call(target, 'details', { id })
}

export async function updateMcpServer(
  target: RuntimeClientTarget,
  id: string,
  version: string,
  config: BotToolInput
): Promise<McpServerView> {
  return served(await change(target, 'update', { id, version, config }))
}

export async function removeMcpServer(target: RuntimeClientTarget, id: string): Promise<void> {
  await change(target, 'remove', { id })
}

export async function setMcpServerAgent(
  target: RuntimeClientTarget,
  id: string,
  agent: string,
  enabled: boolean
): Promise<McpServerView> {
  return served(await change(target, 'setAgentEnabled', { id, agent, enabled }))
}

export async function setMcpServerWorkspaces(
  target: RuntimeClientTarget,
  id: string,
  workspaces: McpServerWorkspaces,
  base: McpServerWorkspaces
): Promise<McpServerView> {
  return served(await change(target, 'setWorkspaces', { id, workspaces, base }))
}

export async function setMcpServerSharedProcess(
  target: RuntimeClientTarget,
  id: string,
  enabled: boolean
): Promise<McpServerView> {
  return served(await change(target, 'setSharedProcess', { id, enabled }))
}

export async function signOutMcpServer(target: RuntimeClientTarget, id: string): Promise<void> {
  await change(target, 'signOut', { id })
}

/**
 * Move takes the server out of the agents' own files (with a backup); copy leaves them as they are.
 * A Move names the agents its confirm showed, so the host takes it out of no other.
 */
export async function importMcpServer(
  target: RuntimeClientTarget,
  server: Pick<DiscoveredMcpServer, 'key' | 'removesFrom'>,
  mode: 'move' | 'copy'
): Promise<McpServerView> {
  const confirmed = mode === 'move' && server.removesFrom ? { agents: server.removesFrom } : {}
  return served(await change(target, mode, { key: server.key, ...confirmed }))
}

export async function allowMcpAgentFile(
  target: RuntimeClientTarget,
  agent: McpFileAgent,
  allowed: boolean
): Promise<McpAgentFiles> {
  return (
    await change<{ agentFiles: McpAgentFiles }>(target, 'agentFiles.allow', { agent, allowed })
  ).agentFiles
}

/** What each server's check found, by server id; starts the servers, so once per page. */
/**
 * `agent`: whose CLI runs the check (Claude Code or Codex; the host picks Claude Code otherwise).
 * `ids`: check only these servers. `requestId`: lets `cancelMcpServerProblems` end only this check.
 */
export async function readMcpServerProblems(
  target: RuntimeClientTarget,
  scope: { agent?: string; ids?: readonly string[]; requestId?: string } = {}
): Promise<Record<string, BotToolProblem>> {
  const { agent, ids, requestId } = scope
  const params = {
    ...(agent === 'claude' || agent === 'codex' ? { agent } : {}),
    ...(ids ? { ids } : {}),
    ...(requestId ? { requestId } : {})
  }
  return (await call<{ problems: Record<string, BotToolProblem> }>(target, 'problems', params))
    .problems
}

export function cancelMcpServerProblems(target: RuntimeClientTarget, requestId?: string): void {
  void call(target, 'cancelProblems', requestId ? { requestId } : {}).catch(() => {})
}

export type McpStaleSessions = { count: number; restartable: number }

/** Running terminal sessions still on an older list; none from a host that can't tell yet. */
export async function readStaleMcpSessions(target: RuntimeClientTarget): Promise<McpStaleSessions> {
  try {
    return await call<McpStaleSessions>(target, 'sessions.stale')
  } catch (error) {
    if (isMcpMethodMissing(error)) {
      return { count: 0, restartable: 0 }
    }
    throw error
  }
}

export function restartStaleMcpSessions(
  target: RuntimeClientTarget
): Promise<{ restarted: number; skipped: number }> {
  return call(target, 'sessions.restart')
}

export function startMcpServerSignIn(
  target: RuntimeClientTarget,
  id: string,
  mode: 'routed' | 'paste'
): Promise<BotToolSignInAttemptView> {
  return call(target, 'signIn.start', { id, mode })
}

export function waitMcpServerSignIn(
  target: RuntimeClientTarget,
  flowId: string,
  afterRevision: number
): Promise<BotToolSignInAttemptView> {
  return call(target, 'signIn.wait', { flowId, afterRevision })
}

export function finishMcpServerSignIn(
  target: RuntimeClientTarget,
  flowId: string,
  query: string
): Promise<BotToolSignInAttemptView> {
  return call(target, 'signIn.finish', { flowId, query })
}

export function cancelMcpServerSignIn(target: RuntimeClientTarget, flowId: string): void {
  void call(target, 'signIn.cancel', { flowId }).catch(() => {})
}
