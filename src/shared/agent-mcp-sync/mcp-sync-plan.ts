import {
  MCP_SYNC_MAX_SERVERS_PER_AGENT,
  MCP_SYNC_SERVER_NAME,
  mcpSyncServerKey,
  type AgentMcpSyncParams,
  type AgentMcpSyncResult,
  type McpSyncAgent,
  type McpSyncServerRow,
  type McpSyncSource
} from './mcp-sync-contract'
import { portMcpServer } from './mcp-server-portability'

/** A server as read from this computer's agent config, secrets included; never leaves main except to the host. */
export type LocalMcpServer = {
  agent: McpSyncAgent
  name: string
  source: McpSyncSource
  config: unknown
}

export type McpSyncPlanInput = {
  servers: readonly LocalMcpServer[]
  /** `agent:name` keys the user turned off. */
  excluded: ReadonlySet<string>
  /** Names the workspace repo's own `.mcp.json` declares; Claude reads that file on the host already. */
  repoServerNames: ReadonlySet<string>
  homeDir: string | null
}

export type McpSyncPlan = { params: AgentMcpSyncParams; rows: McpSyncServerRow[] }

// Claude merges scopes as local (project) over user; keep the one that wins locally.
function dedupe(servers: readonly LocalMcpServer[]): LocalMcpServer[] {
  const byKey = new Map<string, LocalMcpServer>()
  for (const server of servers) {
    const key = mcpSyncServerKey(server.agent, server.name)
    const existing = byKey.get(key)
    if (!existing || server.source === 'claude-project') {
      byKey.set(key, server)
    }
  }
  return [...byKey.values()]
}

export function planMcpSync(input: McpSyncPlanInput): McpSyncPlan {
  const claude: Record<string, Record<string, unknown>> = {}
  const codex: Record<string, Record<string, unknown>> = {}
  const rows: McpSyncServerRow[] = []
  for (const server of dedupe(input.servers)) {
    const key = mcpSyncServerKey(server.agent, server.name)
    const ported = portMcpServer(server.agent, server.config, input.homeDir)
    const included = !input.excluded.has(key)
    const base = {
      key,
      agent: server.agent,
      name: server.name,
      source: server.source,
      transport: ported.transport,
      target: ported.target,
      included
    }
    const skipReason = !MCP_SYNC_SERVER_NAME.test(server.name)
      ? 'invalid'
      : !ported.ok
        ? ported.reason
        : server.agent === 'claude' && input.repoServerNames.has(server.name)
          ? 'in-repo'
          : !included
            ? 'turned-off'
            : null
    const bucket = server.agent === 'claude' ? claude : codex
    if (
      skipReason === null &&
      ported.ok &&
      Object.keys(bucket).length < MCP_SYNC_MAX_SERVERS_PER_AGENT
    ) {
      bucket[server.name] = ported.config
      rows.push({ ...base, state: 'pending' })
    } else {
      rows.push({ ...base, state: 'skipped', skipReason: skipReason ?? 'invalid' })
    }
  }
  rows.sort((a, b) => a.agent.localeCompare(b.agent) || a.name.localeCompare(b.name))
  // Both agents are always named so servers turned off or removed here leave the host too.
  return { params: { claude, codex }, rows }
}

function hostnameOf(origin: string | null): string | null {
  if (!origin) {
    return null
  }
  try {
    return new URL(origin).hostname
  } catch {
    return null
  }
}

/** Fold the host's answer into the rows: outcomes that left nothing working read as skipped. */
export function applyMcpSyncResult(
  rows: readonly McpSyncServerRow[],
  result: AgentMcpSyncResult
): McpSyncServerRow[] {
  const unreachable = new Set(result.unreachableHosts ?? [])
  return rows.map((row) => {
    if (row.state !== 'pending') {
      return row
    }
    const outcome = result[row.agent]?.[row.name]
    if (!outcome) {
      return row
    }
    const synced = outcome === 'added' || outcome === 'updated' || outcome === 'unchanged'
    const host = hostnameOf(row.target)
    return {
      ...row,
      state: synced ? 'synced' : 'skipped',
      outcome,
      ...(synced && row.transport !== 'stdio' && host && unreachable.has(host)
        ? { unreachable: true }
        : {})
    }
  })
}
