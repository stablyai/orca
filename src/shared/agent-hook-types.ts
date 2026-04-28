// Why: these IPC payload shapes live here but have no renderer/main consumer
// in this PR. They are pulled in by the main-process hook server (Claude /
// Codex / Gemini native hook integrations) that lands in the follow-up PR.
// Keeping the types shared up-front avoids a churn PR that renames or splits
// them once the hook server imports them.

export type AgentHookTarget = 'claude' | 'codex' | 'gemini' | 'cursor'

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
//
// v2 (2026-04): scripts now source ORCA_AGENT_HOOK_ENDPOINT (an on-disk file
// written by each Orca start()) for live PORT/TOKEN/ENV/VERSION values,
// falling back to PTY env. Required for surviving PTYs to reach the current
// Orca after a restart — a pre-v2 script still works on a freshly spawned
// PTY but cannot self-heal after the Orca it was stamped with is gone.
export const ORCA_HOOK_PROTOCOL_VERSION = '2' as const
