// Why: these IPC payload shapes live here but have no renderer/main consumer
// in this PR. They are pulled in by the main-process hook server (Claude /
// Codex / Gemini native hook integrations) that lands in the follow-up PR.
// Keeping the types shared up-front avoids a churn PR that renames or splits
// them once the hook server imports them.

export type AgentHookTarget = 'claude' | 'codex' | 'gemini'

export type AgentHookInstallState = 'installed' | 'not_installed' | 'partial' | 'error'

export type AgentHookInstallStatus = {
  agent: AgentHookTarget
  state: AgentHookInstallState
  configPath: string
  managedHooksPresent: boolean
  detail: string | null
}

// Why: bumped whenever the managed script's request shape changes. The
// receiver logs a warning when it sees a request from a different version so a
// stale script installed by an older app build is diagnosable instead of
// silently producing partial payloads.
export const ORCA_HOOK_PROTOCOL_VERSION = '1' as const
