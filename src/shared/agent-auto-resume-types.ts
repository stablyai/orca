// Why: shared vocabulary for the auto-resume feature so main (detection +
// service) and renderer (status surfaces) agree on one contract. Kept separate
// from RuntimeTerminalWaitBlockedReason on purpose: a usage-limit stall must
// NOT be classified as a generic blocked/permission prompt (that would show a
// rate-limited agent as "Needs permission" everywhere terminal.wait is
// consumed), so it travels its own path with its own reason type.

/** Providers whose usage-limit stalls v1 can auto-resume. Architecture stays
 *  open for gemini/opencode later — add a provider + detection patterns. */
export type UsageLimitProvider = 'claude' | 'codex'

/** How the agent CLI is stuck on a provider usage limit.
 *  - `usage-limit-menu`: an interactive blocking menu is up (Claude Code's
 *    "Stop and wait for limit to reset" chooser). Needs a keypress.
 *  - `usage-limit-banner`: the agent is idle at its prompt showing a limit
 *    banner ("You've hit your session limit · resets 3:50pm"). Needs a resend. */
export type UsageLimitStallReason = 'usage-limit-banner' | 'usage-limit-menu'

/** Lifecycle of a tracked stall inside AgentAutoResumeService. */
export type AgentAutoResumePhase = 'waiting' | 'acting' | 'resolved' | 'gave-up'

/** One agent the service is tracking, as surfaced to the renderer. */
export type AgentAutoResumeEntry = {
  ptyId: string
  worktreeId: string | null
  paneKey: string | null
  provider: UsageLimitProvider | null
  reason: UsageLimitStallReason
  /** When the service plans to act (ms epoch), or null while unknown. */
  resumesAt: number | null
  detectedAt: number
  phase: AgentAutoResumePhase
}

/** Pushed to the renderer on every service state change (status bar + cards). */
export type AgentAutoResumeSnapshot = {
  enabled: boolean
  entries: AgentAutoResumeEntry[]
}

export const AGENT_AUTO_RESUME_UPDATE_CHANNEL = 'agentAutoResume:update'
