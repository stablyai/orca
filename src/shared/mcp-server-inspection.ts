import {
  isMcpConfigInspectionFieldWithinLimit,
  isMcpConfigInspectionNameWithinLimit,
  MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS
} from './mcp-config-inspection-limits'
import type { McpServerSummary, McpServerTransport } from './mcp-config'

const SENSITIVE_ENV_KEY_PATTERN =
  /(api[_-]?key|auth|bearer|cookie|credential|password|private[_-]?key|secret|session|token)/i
const SENSITIVE_ENV_VALUE_PATTERN =
  /(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})/

type BoundedString = { value?: string; oversized: boolean }
type BoundedEnv = { value?: Record<string, string>; oversized: boolean }

export function summarizeMcpServer(name: string, entry: unknown): McpServerSummary {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return invalidServer(name, 'Server entry must be an object.')
  }

  const raw = entry as Record<string, unknown>
  const command = readCommand(raw)
  const url = readUrl(raw)
  const env = inspectMcpEnv(raw.env)
  if (command.oversized) {
    return invalidServer(name, 'Command exceeds the MCP inspection field limit.')
  }
  if (url.oversized) {
    return invalidServer(name, 'URL exceeds the MCP inspection field limit.')
  }
  if (env.oversized) {
    return invalidServer(name, 'Environment exceeds the MCP inspection field limits.')
  }

  const transport = resolveTransport(raw, command.value, url.value)
  const enabled = raw.enabled !== false && raw.disabled !== true
  if (transport === 'unknown') {
    return invalidServer(name, 'Missing command or URL.', env.value)
  }
  if (transport === 'http' && !url.value) {
    return invalidServer(name, 'Missing URL.', env.value, transport)
  }
  if (transport === 'stdio' && !command.value) {
    return invalidServer(name, 'Missing command.', env.value, transport)
  }

  return {
    name,
    transport,
    status: enabled ? 'enabled' : 'disabled',
    command: command.value,
    url: url.value,
    env: env.value
  }
}

export function maskMcpEnv(env: unknown): Record<string, string> | undefined {
  return inspectMcpEnv(env).value
}

function inspectMcpEnv(env: unknown): BoundedEnv {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return { oversized: false }
  }

  const masked: Record<string, string> = {}
  let fields = 0
  for (const key in env) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      continue
    }
    fields += 1
    if (
      fields > MCP_CONFIG_INSPECTION_MAX_ENV_FIELDS ||
      !isMcpConfigInspectionNameWithinLimit(key)
    ) {
      return { oversized: true }
    }
    const rawValue = (env as Record<string, unknown>)[key]
    const value = typeof rawValue === 'string' ? rawValue : String(rawValue)
    if (!isMcpConfigInspectionFieldWithinLimit(value)) {
      return { oversized: true }
    }
    masked[key] =
      SENSITIVE_ENV_KEY_PATTERN.test(key) || SENSITIVE_ENV_VALUE_PATTERN.test(value)
        ? '••••••••'
        : value
  }
  return { value: masked, oversized: false }
}

function readCommand(raw: Record<string, unknown>): BoundedString {
  const value =
    typeof raw.command === 'string'
      ? raw.command
      : Array.isArray(raw.command) && typeof raw.command[0] === 'string'
        ? raw.command[0]
        : undefined
  return boundedString(value)
}

function readUrl(raw: Record<string, unknown>): BoundedString {
  const value =
    typeof raw.url === 'string'
      ? raw.url
      : typeof raw.httpUrl === 'string'
        ? raw.httpUrl
        : undefined
  return boundedString(value)
}

function boundedString(value: string | undefined): BoundedString {
  return value === undefined || isMcpConfigInspectionFieldWithinLimit(value)
    ? { value, oversized: false }
    : { oversized: true }
}

function invalidServer(
  name: string,
  issue: string,
  env?: Record<string, string>,
  transport: McpServerTransport = 'unknown'
): McpServerSummary {
  return { name, transport, status: 'invalid', env, issue }
}

function resolveTransport(
  raw: Record<string, unknown>,
  command: string | undefined,
  url: string | undefined
): McpServerTransport {
  if (raw.type === 'http' || raw.type === 'remote' || url) {
    return 'http'
  }
  if (raw.type === 'local' || command) {
    return 'stdio'
  }
  return 'unknown'
}
