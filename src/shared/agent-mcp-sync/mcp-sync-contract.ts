import { z } from 'zod'

export type McpSyncAgent = 'claude' | 'codex'
export const MCP_SYNC_AGENTS: readonly McpSyncAgent[] = ['claude', 'codex']

/** Where a server came from on this computer: Claude Code user or project (local) scope, or Codex. */
export type McpSyncSource = 'claude-user' | 'claude-project' | 'codex'
export type McpSyncTransport = 'stdio' | 'http' | 'sse'

/** Agent CLIs and TOML tables both accept these; anything else is skipped rather than quoted. */
export const MCP_SYNC_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/
export const MCP_SYNC_MAX_SERVERS_PER_AGENT = 64
const MAX_SERVER_CONFIG_KEYS = 32

/** Reasons this computer does not send a server; each row shows one. */
export type McpSyncSkipReason =
  | 'turned-off'
  | 'in-repo'
  | 'local-command'
  | 'local-path'
  | 'local-url'
  | 'invalid'

/** What the host did with a server it was sent. */
export const McpSyncHostOutcome = z.enum([
  'added',
  'updated',
  'unchanged',
  // A same-named server the user configured on the host wins and is never touched.
  'kept-host',
  'command-missing',
  'config-unreadable'
])
export type McpSyncHostOutcome = z.infer<typeof McpSyncHostOutcome>

const ServerConfig = z
  .record(z.string(), z.unknown())
  .refine((value) => Object.keys(value).length <= MAX_SERVER_CONFIG_KEYS, 'Too many fields.')
const ServerSet = z
  .record(z.string().regex(MCP_SYNC_SERVER_NAME), ServerConfig)
  .refine(
    (value) => Object.keys(value).length <= MCP_SYNC_MAX_SERVERS_PER_AGENT,
    'Too many servers.'
  )

/** The complete set this computer manages for each agent named; an omitted agent is left alone. */
export const AgentMcpSyncParams = z
  .object({
    claude: ServerSet.optional(),
    /** Claude project (local) scope servers: written under the host workspace's project, never user scope. */
    claudeProject: ServerSet.optional(),
    codex: ServerSet.optional(),
    /** Stable id of the syncing computer: each one owns (and only removes) its own entries. */
    syncer: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional()
  })
  .strict()
export type AgentMcpSyncParams = z.infer<typeof AgentMcpSyncParams>

export const AgentMcpSyncResult = z.object({
  claude: z.record(z.string(), McpSyncHostOutcome).optional(),
  codex: z.record(z.string(), McpSyncHostOutcome).optional(),
  /** Remote server hostnames this host cannot resolve (its network policy may block them). */
  unreachableHosts: z.array(z.string()).optional()
})
export type AgentMcpSyncResult = z.infer<typeof AgentMcpSyncResult>

export const AGENT_MCP_SYNC_METHOD = 'agentConfig.syncMcpServers'

/** One server as the UI sees it: never args, env, headers or URL query (those often hold secrets). */
export type McpSyncServerRow = {
  key: string
  agent: McpSyncAgent
  name: string
  source: McpSyncSource
  transport: McpSyncTransport | null
  /** URL origin for remote servers, command name for local ones. */
  target: string | null
  included: boolean
  state: 'synced' | 'skipped' | 'pending'
  skipReason?: McpSyncSkipReason
  outcome?: McpSyncHostOutcome
  /** Synced, but the host could not resolve the server's hostname. */
  unreachable?: boolean
}

export type McpSyncStatus = {
  environmentId: string
  autoSync: boolean
  running: boolean
  lastSyncedAt: number | null
  error: 'host-outdated' | 'host-unreachable' | 'failed' | null
  rows: McpSyncServerRow[]
}

export const mcpSyncServerKey = (agent: McpSyncAgent, name: string): string => `${agent}:${name}`
