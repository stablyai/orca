// Why: shared agent-hook IPC payload shapes and the managed-script protocol
// version constant. Consumed by both the main-process hook server (src/main/
// agent-hooks/server.ts) and each per-agent hook service. Lives in `shared/`
// to keep a single source of truth for the version string and status contract.

export const AGENT_HOOK_TARGETS = [
  'claude',
  'openclaude',
  'codex',
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
  'kimi'
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
  managedHooksPresent: boolean
  detail: string | null
  skipReason?: AgentHookInstallSkipReason
}

// Why: bumped whenever the managed script's request shape changes. The
// receiver logs a warning when it sees a request from a different version so a
// stale script installed by an older app build is diagnosable instead of
// silently producing partial payloads. v2 adds Codex reviewer ownership so
// auto-review PermissionRequest events can be consumed before user-facing
// lifecycle and notification state.
export const ORCA_HOOK_PROTOCOL_VERSION = '2' as const
