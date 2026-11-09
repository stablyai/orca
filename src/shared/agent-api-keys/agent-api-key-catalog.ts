import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../agent-launch/catalog/tui-agent-config'
import type { ExecutionHostId } from '../execution-host'

/** Where a stored key is injected. `hosts` lists execution host ids (`local`, `ssh:…`, `runtime:…`). */
export type AgentApiKeyHostScope = { kind: 'all' } | { kind: 'hosts'; hostIds: ExecutionHostId[] }

/** What the renderer may see of a stored key: never the value. */
export type AgentApiKeySummary = {
  id: string
  agent: TuiAgent
  envName: string
  hostScope: AgentApiKeyHostScope
  /** Last four characters, so two keys can be told apart. */
  hint: string
  updatedAt: number
}

export type AgentApiKeyProtection = { available: true } | { available: false; reason: string }

export type AgentApiKeysState = {
  keys: AgentApiKeySummary[]
  protection: AgentApiKeyProtection
}

export type AgentApiKeysMutationResult =
  | { ok: true; state: AgentApiKeysState }
  | { ok: false; error: string; state: AgentApiKeysState }

export type AgentApiKeySaveRequest = {
  /** Present when editing; an edit without `value` keeps the stored value. */
  id?: string
  agent: TuiAgent
  envName: string
  value?: string
  hostScope: AgentApiKeyHostScope
}

export type AgentApiKeyPreset = {
  envName: string
  /** Shown next to the variable so users know which credential it takes. */
  label: string
  placeholder: string
}

/** The variables each agent's CLI reads for API-key auth; anything else goes through "Other variable". */
export const AGENT_API_KEY_PRESETS: Partial<Record<TuiAgent, readonly AgentApiKeyPreset[]>> = {
  claude: [
    { envName: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', placeholder: 'sk-ant-api03-…' },
    {
      envName: 'AWS_BEARER_TOKEN_BEDROCK',
      label: 'Amazon Bedrock API key',
      placeholder: 'Bedrock API key'
    }
  ],
  codex: [{ envName: 'OPENAI_API_KEY', label: 'OpenAI API key', placeholder: 'sk-proj-…' }],
  gemini: [{ envName: 'GEMINI_API_KEY', label: 'Gemini API key', placeholder: 'AIza…' }],
  cursor: [{ envName: 'CURSOR_API_KEY', label: 'Cursor API key', placeholder: 'key_…' }],
  opencode: [
    { envName: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', placeholder: 'sk-ant-api03-…' },
    { envName: 'OPENAI_API_KEY', label: 'OpenAI API key', placeholder: 'sk-proj-…' }
  ]
}

/** Agents listed first in Settings; any other agent can be added. */
export const FEATURED_API_KEY_AGENTS: readonly TuiAgent[] = ['claude', 'codex', 'gemini', 'cursor']

/** Agent variants that run the same CLI and therefore share its keys. */
const KEY_AGENT_ALIASES: Partial<Record<TuiAgent, TuiAgent>> = {
  'claude-agent-teams': 'claude'
}

export function apiKeyAgentFor(agent: TuiAgent): TuiAgent {
  return KEY_AGENT_ALIASES[agent] ?? agent
}

export const MAX_AGENT_API_KEYS = 64
export const MAX_AGENT_API_KEY_VALUE_LENGTH = 16 * 1024
const MAX_ENV_NAME_LENGTH = 128
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/

/** Variables that steer the shell, loader, Orca or account routing; a key named like these would hijack the launch. */
const RESERVED_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'TERM',
  'TMPDIR',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'PERL5OPT',
  'PERL5LIB',
  'RUBYOPT',
  'RUBYLIB',
  'PYTHONHOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'COMSPEC',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'PROMPT_COMMAND',
  'IFS',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'SSH_AUTH_SOCK'
])
// A proxy or CA override could route the key itself elsewhere, so those are reserved too.
const RESERVED_ENV_PREFIXES = ['ORCA_', 'LD_', 'DYLD_', 'GIT_', 'XDG_']

/** Subscription credentials belong to the agent's own login on each machine and are never stored. */
const SUBSCRIPTION_TOKEN_ENV_NAMES = new Set(['CLAUDE_CODE_OAUTH_TOKEN'])
const SUBSCRIPTION_TOKEN_PREFIXES = ['sk-ant-oat', 'sk-ant-ort']
const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/

export function agentApiKeyEnvNameError(envName: string): string | null {
  if (!envName || envName.length > MAX_ENV_NAME_LENGTH || !ENV_NAME_PATTERN.test(envName)) {
    return 'Use capital letters, digits and underscores, like ANTHROPIC_API_KEY.'
  }
  if (SUBSCRIPTION_TOKEN_ENV_NAMES.has(envName)) {
    return 'Orca does not store subscription sign-ins. Sign in to the agent on each host instead.'
  }
  if (
    RESERVED_ENV_NAMES.has(envName) ||
    RESERVED_ENV_PREFIXES.some((prefix) => envName.startsWith(prefix))
  ) {
    return `${envName} controls how the agent starts, so it can't be set here.`
  }
  return null
}

export function agentApiKeyValueError(envName: string, value: string): string | null {
  if (!value) {
    return 'Paste the key.'
  }
  if (value.length > MAX_AGENT_API_KEY_VALUE_LENGTH) {
    return 'That value is too long to be an API key.'
  }
  // oxlint-disable-next-line no-control-regex -- A key is one line of printable text.
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    return 'Keys are a single line.'
  }
  // Claude.ai and ChatGPT sign-ins are OAuth tokens (sk-ant-oat…, JWTs); policy forbids holding them.
  if (
    SUBSCRIPTION_TOKEN_PREFIXES.some((prefix) => value.startsWith(prefix)) ||
    (/^(ANTHROPIC|OPENAI|CODEX)_/.test(envName) && JWT_PATTERN.test(value))
  ) {
    return 'This looks like a subscription sign-in token, which Orca does not store. Use an API key from the provider console.'
  }
  return null
}

export function isAgentApiKeyHostScope(value: unknown): value is AgentApiKeyHostScope {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const scope = value as { kind?: unknown; hostIds?: unknown }
  if (scope.kind === 'all') {
    return true
  }
  return (
    scope.kind === 'hosts' &&
    Array.isArray(scope.hostIds) &&
    scope.hostIds.length > 0 &&
    scope.hostIds.length <= 256 &&
    scope.hostIds.every(
      (id) =>
        typeof id === 'string' &&
        id.length <= 1024 &&
        (id === 'local' || id.startsWith('ssh:') || id.startsWith('runtime:'))
    )
  )
}

export function isAgentApiKeyAgent(value: unknown): value is TuiAgent {
  return isTuiAgent(value) && apiKeyAgentFor(value) === value
}

function scopeIncludes(scope: AgentApiKeyHostScope, hostId: ExecutionHostId): boolean {
  return scope.kind === 'all' || scope.hostIds.includes(hostId)
}

/** The key per variable that applies to `agent` on `hostId`: a host-specific key beats an all-hosts one. */
export function selectAgentApiKeys<
  T extends Pick<AgentApiKeySummary, 'agent' | 'envName' | 'hostScope' | 'updatedAt'>
>(keys: readonly T[], agent: TuiAgent, hostId: ExecutionHostId): T[] {
  const keyAgent = apiKeyAgentFor(agent)
  const byName = new Map<string, T>()
  for (const key of keys) {
    if (key.agent !== keyAgent || !scopeIncludes(key.hostScope, hostId)) {
      continue
    }
    const current = byName.get(key.envName)
    const rank = (entry: T): number => (entry.hostScope.kind === 'hosts' ? 1 : 0)
    if (
      !current ||
      rank(key) > rank(current) ||
      (rank(key) === rank(current) && key.updatedAt > current.updatedAt)
    ) {
      byName.set(key.envName, key)
    }
  }
  return [...byName.values()]
}
