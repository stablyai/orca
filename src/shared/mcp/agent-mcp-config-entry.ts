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

// Keys each dialect may hold beside the ones read into Orca's shape. Anything else (tool filters,
// OAuth clients, token files, working folders, exposure) changes what the server does, so the
// entry stays in its agent rather than being moved without it.
const HARMLESS_KEYS: Record<AgentMcpConfigDialect, ReadonlySet<string>> = {
  'mcp-json': new Set(['type', 'transport', 'enabled', 'disabled', 'timeout', 'description']),
  gemini: new Set(['type', 'timeout', 'description', 'trust']),
  'opencode-v1': new Set(['type', 'enabled', 'timeout']),
  'opencode-v2': new Set(['type', 'disabled', 'timeout']),
  'codex-toml': new Set([
    'enabled',
    'startup_timeout_sec',
    'startup_timeout_ms',
    'tool_timeout_sec'
  ]),
  'grok-toml': new Set([
    'type',
    'enabled',
    'startup_timeout_sec',
    'tool_timeout_sec',
    'tool_timeouts'
  ])
}

const READ_KEYS: Record<AgentMcpConfigDialect, ReadonlySet<string>> = {
  'mcp-json': new Set(['command', 'args', 'env', 'url', 'httpUrl', 'serverUrl', 'headers']),
  gemini: new Set(['command', 'args', 'env', 'url', 'httpUrl', 'headers']),
  'opencode-v1': new Set(['command', 'environment', 'url', 'headers']),
  'opencode-v2': new Set(['command', 'environment', 'url', 'headers']),
  'codex-toml': new Set(['command', 'args', 'env', 'url', 'http_headers']),
  'grok-toml': new Set(['command', 'args', 'env', 'url', 'headers'])
}

function carriesEveryKey(entry: Record<string, unknown>, dialect: AgentMcpConfigDialect): boolean {
  return Object.entries(entry).every(
    ([key, value]) =>
      READ_KEYS[dialect].has(key) ||
      HARMLESS_KEYS[dialect].has(key) ||
      // Copilot writes `tools: ["*"]` for "every tool".
      (key === 'tools' && Array.isArray(value) && value.length === 1 && value[0] === '*')
  )
}

// Values the agent fills in from its environment or a command when it starts: `${VAR}` (Claude,
// Cursor's `${env:VAR}`, Pi), OpenCode's `{env:VAR}` / `{file:path}`, Gemini's `$VAR`, Pi's `!command`.
function substitutes(value: string, dialect: AgentMcpConfigDialect): boolean {
  return (
    /\$\{[^}]*\}|\{(env|file):[^}]*\}/.test(value) ||
    (dialect === 'gemini' && /\$[A-Za-z_]/.test(value)) ||
    (dialect === 'mcp-json' && value.startsWith('!'))
  )
}

function fieldsSubstitute(fields: ServerFields, dialect: AgentMcpConfigDialect): boolean {
  const values =
    'url' in fields
      ? [fields.url, ...Object.values(fields.headers ?? {})]
      : [fields.command, ...fields.args, ...Object.values(fields.env ?? {})]
  return values.some((value) => substitutes(value, dialect))
}

const isStreamableHttp = (type: unknown): boolean =>
  type === undefined || type === 'http' || type === 'streamable-http'

function mcpJsonFields(entry: Record<string, unknown>, dialect: AgentMcpConfigDialect) {
  const type = entry.type ?? entry.transport
  if (typeof entry.command === 'string') {
    // `local` is Copilot's name for stdio.
    return type === undefined || type === 'stdio' || type === 'local'
      ? commandFields(entry.command, entry.args, entry.env)
      : null
  }
  if (entry.httpUrl !== undefined) {
    return type === undefined ? remoteFields(entry.httpUrl, entry.headers) : null
  }
  // Gemini reads a bare `url` as SSE; Orca's servers speak streamable HTTP only.
  if (dialect === 'gemini' && type !== 'http') {
    return null
  }
  return isStreamableHttp(type) ? remoteFields(entry.url ?? entry.serverUrl, entry.headers) : null
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
  if (typeof entry.command === 'string') {
    return entry.type === undefined || entry.type === 'stdio'
      ? commandFields(entry.command, entry.args, entry.env)
      : null
  }
  return isStreamableHttp(entry.type)
    ? remoteFields(entry.url, dialect === 'codex-toml' ? entry.http_headers : entry.headers)
    : null
}

function entryFields(entry: Record<string, unknown>, dialect: AgentMcpConfigDialect) {
  if (!carriesEveryKey(entry, dialect)) {
    return null
  }
  switch (dialect) {
    case 'opencode-v1':
    case 'opencode-v2':
      return openCodeFields(entry)
    case 'codex-toml':
    case 'grok-toml':
      return tomlFields(entry, dialect)
    case 'mcp-json':
    case 'gemini':
      return mcpJsonFields(entry, dialect)
  }
}

function entryDisabled(entry: Record<string, unknown>, dialect: AgentMcpConfigDialect): boolean {
  return dialect === 'opencode-v2'
    ? entry.disabled === true
    : entry.enabled === false || entry.disabled === true
}

/**
 * Null when Orca can't run the entry exactly as its agent does: SSE, a key Orca would drop (tool
 * filters, OAuth client, token file, working folder), a value the agent substitutes, a bad value.
 */
export function agentMcpConfigEntry(
  configName: string,
  raw: unknown,
  dialect: AgentMcpConfigDialect
): AgentMcpConfigEntry | null {
  const entry = record(raw)
  const fields = entry ? entryFields(entry, dialect) : null
  if (!entry || !fields || fieldsSubstitute(fields, dialect)) {
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

function sorted(value: Record<string, string> | undefined): [string, string][] {
  return Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right))
}

/**
 * One server across agents: the same name and the whole definition (URL or command line, headers,
 * environment). Two copies that differ anywhere are two rows, so moving one never drops the other.
 */
export function agentMcpServerMergeKey(configName: string, server: BotToolServer): string {
  return JSON.stringify(
    'url' in server
      ? [configName, 'url', server.url, sorted(server.headers)]
      : [configName, 'command', server.command, server.args, sorted(server.env)]
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
