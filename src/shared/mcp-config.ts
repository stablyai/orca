export type McpConfigFormat = 'workspace' | 'cursor' | 'claude'

export type McpConfigCandidate = {
  format: McpConfigFormat
  label: string
  relativePath: string
  serversPath: string[]
}

export type McpServerTransport = 'stdio' | 'http' | 'unknown'
export type McpServerStatus = 'enabled' | 'disabled' | 'invalid'

export type McpServerSummary = {
  name: string
  transport: McpServerTransport
  status: McpServerStatus
  command?: string
  url?: string
  env?: Record<string, string>
  issue?: string
}

export type McpConfigInspection = {
  candidate: McpConfigCandidate
  exists: boolean
  status: 'missing' | 'valid' | 'invalid'
  servers: McpServerSummary[]
  error?: string
}

export const MCP_CONFIG_CANDIDATES: McpConfigCandidate[] = [
  {
    format: 'workspace',
    label: 'Workspace',
    relativePath: '.mcp.json',
    serversPath: ['mcpServers']
  },
  {
    format: 'cursor',
    label: 'Cursor',
    relativePath: '.cursor/mcp.json',
    serversPath: ['mcpServers']
  },
  {
    format: 'claude',
    label: 'Claude',
    relativePath: '.claude.json',
    serversPath: ['mcpServers']
  },
  {
    format: 'claude',
    label: 'Claude workspace',
    relativePath: '.claude/mcp.json',
    serversPath: ['mcpServers']
  }
]

export const MCP_STARTER_CONFIG = `{
  "mcpServers": {}
}
`

const SENSITIVE_ENV_KEY_PATTERN =
  /(api[_-]?key|auth|bearer|cookie|credential|password|private[_-]?key|secret|session|token)/i
const SENSITIVE_ENV_VALUE_PATTERN =
  /(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})/

export function inspectMcpConfigContent(
  candidate: McpConfigCandidate,
  content: string | null
): McpConfigInspection {
  if (content === null) {
    return { candidate, exists: false, status: 'missing', servers: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    return {
      candidate,
      exists: true,
      status: 'invalid',
      servers: [],
      error: error instanceof Error ? error.message : 'Invalid JSON'
    }
  }

  const rawServers = extractObjectAtPath(parsed, candidate.serversPath)
  if (!rawServers) {
    return { candidate, exists: true, status: 'valid', servers: [] }
  }

  return {
    candidate,
    exists: true,
    status: 'valid',
    servers: Object.entries(rawServers).map(([name, entry]) => summarizeMcpServer(name, entry))
  }
}

export function maskMcpEnv(env: unknown): Record<string, string> | undefined {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return undefined
  }

  const masked: Record<string, string> = {}
  for (const [key, rawValue] of Object.entries(env)) {
    const value = typeof rawValue === 'string' ? rawValue : String(rawValue)
    masked[key] =
      SENSITIVE_ENV_KEY_PATTERN.test(key) || SENSITIVE_ENV_VALUE_PATTERN.test(value)
        ? '••••••••'
        : value
  }
  return masked
}

function extractObjectAtPath(
  value: unknown,
  pathSegments: string[]
): Record<string, unknown> | null {
  let current = value
  for (const segment of pathSegments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return null
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current && typeof current === 'object' && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : null
}

function summarizeMcpServer(name: string, entry: unknown): McpServerSummary {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return {
      name,
      transport: 'unknown',
      status: 'invalid',
      issue: 'Server entry must be an object.'
    }
  }

  const raw = entry as Record<string, unknown>
  const command = readCommand(raw)
  const url = readUrl(raw)
  const transport = resolveTransport(raw, command, url)
  const enabled = raw.enabled !== false && raw.disabled !== true
  const env = maskMcpEnv(raw.env)

  if (transport === 'unknown') {
    return {
      name,
      transport,
      status: 'invalid',
      env,
      issue: 'Missing command or URL.'
    }
  }

  return {
    name,
    transport,
    status: enabled ? 'enabled' : 'disabled',
    command,
    url,
    env
  }
}

function readCommand(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.command === 'string') {
    return raw.command
  }
  if (Array.isArray(raw.command) && typeof raw.command[0] === 'string') {
    return raw.command[0]
  }
  return undefined
}

function readUrl(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.url === 'string') {
    return raw.url
  }
  if (typeof raw.httpUrl === 'string') {
    return raw.httpUrl
  }
  return undefined
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
