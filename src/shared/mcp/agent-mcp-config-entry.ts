// One MCP server entry as an agent's own config (or a pasted config) spells it, read into Orca's
// server shape. An entry Orca can't carry faithfully reads as null, so it stays in the agent.
import {
  BOT_TOOL_NAME_PATTERN,
  BotToolServerSchema,
  botToolNameFrom,
  type BotToolServer
} from '../bot-tools'

/**
 * - `mcp-json`: the `mcpServers` family (Claude Code, Cursor, Copilot, Droid, Pi, Amp, pasted JSON).
 * - `gemini`: like `mcp-json`, but a bare `url` is SSE and `httpUrl` is streamable HTTP.
 * - `opencode-v1` / `opencode-v2`: `type: local|remote`, the command as one array, `environment`.
 * - `codex-toml` / `grok-toml`: `[mcp_servers.<name>]` tables.
 */
export type AgentMcpConfigDialect =
  | 'mcp-json'
  | 'gemini'
  | 'opencode-v1'
  | 'opencode-v2'
  | 'codex-toml'
  | 'grok-toml'

export type AgentMcpConfigEntry = {
  /** The entry's key in the agent's config, as written there. */
  configName: string
  server: BotToolServer
  /** The agent keeps the entry but doesn't start it. */
  disabled: boolean
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

/** A string map, undefined when absent, null when any value isn't a string. */
function stringMap(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined) {
    return undefined
  }
  const entries = record(value)
  if (!entries) {
    return null
  }
  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(entries)) {
    if (typeof item !== 'string') {
      return null
    }
    out[key] = item
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function stringList(value: unknown): string[] | null {
  if (value === undefined) {
    return []
  }
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null
}

/** Orca's server names are narrower than agents' keys (`my.server`, `My Server`). */
export function mcpServerNameFromConfigName(configName: string, fallbackDetail: string): string {
  if (BOT_TOOL_NAME_PATTERN.test(configName)) {
    return configName
  }
  const cleaned = configName
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64)
  return BOT_TOOL_NAME_PATTERN.test(cleaned) ? cleaned : botToolNameFrom(fallbackDetail)
}

type ServerFields =
  | { url: string; headers?: Record<string, string> }
  | { command: string; args: string[]; env?: Record<string, string> }

function remoteFields(url: unknown, headers: unknown): ServerFields | null {
  const headerMap = stringMap(headers)
  if (typeof url !== 'string' || headerMap === null) {
    return null
  }
  return { url, ...(headerMap ? { headers: headerMap } : {}) }
}

function commandFields(command: unknown, args: unknown, env: unknown): ServerFields | null {
  const argList = stringList(args)
  const envMap = stringMap(env)
  if (typeof command !== 'string' || argList === null || envMap === null) {
    return null
  }
  return { command, args: argList, ...(envMap ? { env: envMap } : {}) }
}

function mcpJsonFields(entry: Record<string, unknown>, dialect: AgentMcpConfigDialect) {
  const type = entry.type ?? entry.transport
  if (type !== undefined && typeof type !== 'string') {
    return null
  }
  if (typeof entry.command === 'string') {
    // `local` is Copilot's name for stdio.
    return type === undefined || type === 'stdio' || type === 'local'
      ? commandFields(entry.command, entry.args, entry.env)
      : null
  }
  if (entry.httpUrl !== undefined) {
    return remoteFields(entry.httpUrl, entry.headers)
  }
  // Gemini reads a bare `url` as SSE; Orca's servers speak streamable HTTP only.
  if (dialect === 'gemini' && type !== 'http') {
    return null
  }
  return type === undefined || type === 'http' || type === 'streamable-http'
    ? remoteFields(entry.url ?? entry.serverUrl, entry.headers)
    : null
}

function openCodeFields(entry: Record<string, unknown>): ServerFields | null {
  if (entry.type === 'remote') {
    return remoteFields(entry.url, entry.headers)
  }
  const command = stringList(entry.command)
  if (entry.type !== 'local' || !command || command.length === 0) {
    return null
  }
  const [program, ...args] = command
  return commandFields(program, args, entry.environment)
}

function tomlFields(entry: Record<string, unknown>, dialect: AgentMcpConfigDialect) {
  // Codex reads these from its own environment at start; Orca can't carry that indirection.
  if (
    entry.bearer_token_env_var !== undefined ||
    entry.env_http_headers !== undefined ||
    entry.env_vars !== undefined
  ) {
    return null
  }
  if (typeof entry.command === 'string') {
    return commandFields(entry.command, entry.args, entry.env)
  }
  return remoteFields(entry.url, dialect === 'codex-toml' ? entry.http_headers : entry.headers)
}

function entryFields(entry: Record<string, unknown>, dialect: AgentMcpConfigDialect) {
  // A working folder of its own can't be carried by Orca's server shape.
  if (entry.cwd !== undefined) {
    return null
  }
  switch (dialect) {
    case 'opencode-v1':
    case 'opencode-v2':
      return openCodeFields(entry)
    case 'codex-toml':
    case 'grok-toml':
      return tomlFields(entry, dialect)
    default:
      return mcpJsonFields(entry, dialect)
  }
}

function entryDisabled(entry: Record<string, unknown>, dialect: AgentMcpConfigDialect): boolean {
  return dialect === 'opencode-v2'
    ? entry.disabled === true
    : entry.enabled === false || entry.disabled === true
}

/** Null when the entry isn't a server Orca can run as written (SSE, env indirection, cwd, bad values). */
export function agentMcpConfigEntry(
  configName: string,
  raw: unknown,
  dialect: AgentMcpConfigDialect
): AgentMcpConfigEntry | null {
  const entry = record(raw)
  const fields = entry ? entryFields(entry, dialect) : null
  if (!entry || !fields) {
    return null
  }
  const detail = 'url' in fields ? fields.url : [fields.command, ...fields.args].join(' ')
  const parsed = BotToolServerSchema.safeParse({
    name: mcpServerNameFromConfigName(configName, detail),
    ...fields
  })
  return parsed.success
    ? { configName, server: parsed.data, disabled: entryDisabled(entry, dialect) }
    : null
}

/** One server across agents: the same name and the same URL or command line. */
export function agentMcpServerMergeKey(configName: string, server: BotToolServer): string {
  return JSON.stringify(
    'url' in server
      ? [configName, 'url', server.url]
      : [configName, 'command', server.command, ...server.args]
  )
}

const ORCA_LAUNCHER = /(^|[\\/])orca(-[a-z]+)?(\.(cmd|exe))?$/i

/**
 * An entry Orca keeps in an agent's file itself: the `orca mcp connect` / `orca mcp exec` bridge,
 * possibly behind `cmd /c`, which pins Orca's data folder. Never listed as the agent's own.
 */
export function isOrcaOwnedAgentMcpServer(server: BotToolServer): boolean {
  if ('url' in server) {
    return false
  }
  if (server.env?.ORCA_USER_DATA_PATH !== undefined) {
    return true
  }
  const words = [server.command, ...server.args]
  return words.some(
    (word, index) =>
      ORCA_LAUNCHER.test(word) &&
      words[index + 1] === 'mcp' &&
      (words[index + 2] === 'connect' || words[index + 2] === 'exec')
  )
}
