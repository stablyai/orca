import type { McpSyncAgent, McpSyncSkipReason, McpSyncTransport } from './mcp-sync-contract'

export type PortedMcpServer = {
  transport: McpSyncTransport | null
  target: string | null
} & ({ ok: true; config: Record<string, unknown> } | { ok: false; reason: McpSyncSkipReason })

// Launchers a Linux VM resolves on PATH; an absolute local path to one is rewritten to the bare name.
const PORTABLE_LAUNCHERS = new Set([
  'node',
  'npx',
  'npm',
  'pnpm',
  'pnpx',
  'yarn',
  'bun',
  'bunx',
  'deno',
  'uv',
  'uvx',
  'python',
  'python3',
  'pipx',
  'docker',
  'podman',
  'go',
  'java'
])

// Paths that exist only on the user's own computer (macOS app bundles, Homebrew, user homes, drives).
const LOCAL_ONLY_PATH =
  /^(?:\/Applications\/|\/opt\/homebrew\/|\/usr\/local\/(?:Cellar|Caskroom|opt|Homebrew)\/|\/Users\/|\/Volumes\/|\/Library\/|\/System\/|\/private\/|~\/|[A-Za-z]:[\\/]|\\\\)|\.app\/Contents\//

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'])

/** A JSON/TOML table: MCP configs are only ever read through this guard. */
export function isMcpRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** A value naming a file on this computer: local-only prefixes, or anything under this user's home. */
export function isLocalOnlyPath(value: string, homeDir: string | null): boolean {
  const trimmed = value.trim()
  if (LOCAL_ONLY_PATH.test(trimmed)) {
    return true
  }
  if (!homeDir || homeDir === '/') {
    return false
  }
  // `--config=/home/me/x` style arguments embed the path after a flag.
  return trimmed === homeDir || trimmed.includes(`${homeDir}/`) || trimmed.includes(`${homeDir}\\`)
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value]
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
  }
  if (isMcpRecord(value)) {
    return Object.values(value).filter((item): item is string => typeof item === 'string')
  }
  return []
}

function transportOf(agent: McpSyncAgent, raw: Record<string, unknown>): McpSyncTransport | null {
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : undefined
  if (agent === 'claude' && (type === 'http' || type === 'sse')) {
    return type
  }
  if (agent === 'claude' && type === 'streamable-http') {
    return 'http'
  }
  if (typeof raw.url === 'string') {
    return 'http'
  }
  if (typeof raw.command === 'string') {
    return 'stdio'
  }
  return null
}

/** Origin only: user info, path and query (API keys often ride in `?key=`) stay on this computer. */
function urlTarget(url: string): { origin: string; loopback: boolean } | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null
    }
    return { origin: parsed.origin, loopback: LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) }
  } catch {
    return null
  }
}

/** Decide whether a local server can run on a Linux host and rewrite what can be made portable.
 * Remote (http/sse) servers travel as-is unless they point at this computer's loopback. */
export function portMcpServer(
  agent: McpSyncAgent,
  entry: unknown,
  homeDir: string | null
): PortedMcpServer {
  if (!isMcpRecord(entry)) {
    return { ok: false, reason: 'invalid', transport: null, target: null }
  }
  const transport = transportOf(agent, entry)
  if (transport === 'http' || transport === 'sse') {
    const target = typeof entry.url === 'string' ? urlTarget(entry.url) : null
    if (!target) {
      return { ok: false, reason: 'invalid', transport, target: null }
    }
    if (target.loopback) {
      return { ok: false, reason: 'local-url', transport, target: target.origin }
    }
    // Claude runs headersHelper as a command; it must exist on the host too.
    const helper = typeof entry.headersHelper === 'string' ? entry.headersHelper : null
    if (helper && isLocalOnlyPath(helper.split(/\s+/)[0] ?? helper, homeDir)) {
      return { ok: false, reason: 'local-command', transport, target: target.origin }
    }
    return { ok: true, config: { ...entry }, transport, target: target.origin }
  }
  if (transport !== 'stdio' || typeof entry.command !== 'string' || !entry.command.trim()) {
    return { ok: false, reason: 'invalid', transport, target: null }
  }
  const command = entry.command.trim()
  const name = basename(command)
  const absolute = /^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)/.test(command)
  const launcher = name.replace(/\.exe$/i, '')
  const portableCommand = absolute && PORTABLE_LAUNCHERS.has(launcher) ? launcher : command
  if (portableCommand === command && isLocalOnlyPath(command, homeDir)) {
    return { ok: false, reason: 'local-command', transport, target: name }
  }
  const pathValues = [
    ...stringValues(entry.args),
    ...stringValues(entry.env),
    ...stringValues(entry.cwd)
  ]
  if (pathValues.some((value) => isLocalOnlyPath(value, homeDir))) {
    return { ok: false, reason: 'local-path', transport, target: basename(portableCommand) }
  }
  return {
    ok: true,
    config: { ...entry, command: portableCommand },
    transport,
    target: basename(portableCommand)
  }
}
