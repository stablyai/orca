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

/** Agents whose hook events Orca ingests WITHOUT installing its managed hook
 *  scripts, because the agent ships its own plugin/extension mechanism that
 *  posts to the same endpoint.
 *
 *  Why this is separate from AGENT_HOOK_TARGETS: that list answers "does Orca
 *  install its scripts into this CLI", which is a different question from "can
 *  Orca observe this agent". Treating the first as the answer to the second
 *  reports a fully observable agent as unobservable — the exact mistake that
 *  classified OpenCode/GLM as having no native route.
 */
export const PLUGIN_HOOK_AGENTS = ['opencode'] as const
export type PluginHookAgent = (typeof PLUGIN_HOOK_AGENTS)[number]

/** True when Orca can receive hook events for this agent by ANY mechanism. */
export function hasAgentHookIngestion(agent: string): boolean {
  return (
    (AGENT_HOOK_TARGETS as readonly string[]).includes(agent) ||
    (PLUGIN_HOOK_AGENTS as readonly string[]).includes(agent)
  )
}

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
// silently producing partial payloads. Still at v1 because the endpoint-file
// rollout is additive — pre-endpoint-file scripts still post the same JSON
// body shape, and no in-wild v1 script exists that a future v2 receiver would
// need to distinguish from: Claude/Codex/Gemini installs run for everyone on
// first launch but no v1 fleet ever shipped, and Cursor's managed script is
// rewritten on every install() call so there is no durable on-disk v1 script
// to inherit. Reserve the next bump for a real wire change.
export const ORCA_HOOK_PROTOCOL_VERSION = '1' as const

// Why: absence means the listener predates raw-JSON metadata headers, so managed scripts must keep using form posts.
export const ORCA_HOOK_RAW_JSON_TRANSPORT = 'raw-json-v1' as const
