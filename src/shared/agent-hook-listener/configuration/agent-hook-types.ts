// Shared renderer IPC/install contract; keep one protocol version for server and per-agent services.

export const AGENT_HOOK_TARGETS = [
  'claude',
  'openclaude',
  'codex',
  'qoder',
  'qoder-cn',
  'qwen-code',
  'codebuddy',
  'gemini',
  'antigravity',
  'amp',
  'cursor',
  'droid',
  'command-code',
  'grok',
  'copilot',
  'hermes',
  'devin',
  'kimi',
  'muse',
  'zcode',
  'dsh',
  'jcode',
  'kiro'
] as const
export type AgentHookTarget = (typeof AGENT_HOOK_TARGETS)[number]

export type AgentHookInstallState = 'installed' | 'not_installed' | 'partial' | 'error' | 'skipped'

export type AgentHookInstallSkipReason =
  | 'agent_disabled'
  | 'cli_not_found'
  | 'cli_presence_unknown'
  | 'hooks_disabled'

export type AgentHookInstallStatus = {
  agent: AgentHookTarget
  state: AgentHookInstallState
  configPath: string
  /** Other files carrying this agent's managed hooks; configPath is the one state and detail describe. */
  additionalConfigPaths?: string[]
  managedHooksPresent: boolean
  detail: string | null
  skipReason?: AgentHookInstallSkipReason
}

export function getAgentHookConfigPaths(status: AgentHookInstallStatus): string[] {
  return [status.configPath, ...(status.additionalConfigPaths ?? [])].filter(Boolean)
}

// Reserve version bumps for wire changes. Endpoint files are additive; no durable pre-rollout v1 fleet needs distinguishing, and Cursor scripts rewrite on install. Mismatches warn about stale scripts.
export const ORCA_HOOK_PROTOCOL_VERSION = '1' as const

// Why: absence means the listener predates raw-JSON metadata headers, so managed scripts must keep using form posts.
export const ORCA_HOOK_RAW_JSON_TRANSPORT = 'raw-json-v1' as const
