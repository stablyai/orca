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
 *    banner ("You've hit your session limit · resets 3:50pm"). Needs a resend.
 *  - `usage-limit-reset-prompt`: the CLI's own auto-continue gave up counting
 *    down (it does that after a long sleep) and now waits for a single keypress
 *    — "Your usage limit has reset · press enter to continue". The limit is
 *    already over, so there is nothing to wait for and nothing to type.
 *  - `usage-limit-cli-waiting`: Claude Code 2.1.234+ is waiting out the limit
 *    itself ("continuing automatically at 3:45pm · esc to cancel"). Not ours to
 *    act on — resuming here would double-send — but the pane is still blocked,
 *    so it is recorded rather than ignored. */
export type UsageLimitStallReason =
  | 'usage-limit-banner'
  | 'usage-limit-menu'
  | 'usage-limit-reset-prompt'
  | 'usage-limit-cli-waiting'

/** Lifecycle of a tracked stall inside AgentAutoResumeService. Only these two:
 *  a resolved or given-up stall is deleted from the tracked map rather than
 *  retained in a terminal phase, so no other value can reach the renderer. */
export type AgentAutoResumePhase = 'waiting' | 'acting'

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

/** Pushed to the renderer on every service state change (status bar + cards).
 *  There is no global on/off: opt-in lives on each terminal's rate-limit
 *  watcher flag, so an empty list simply means nothing is stalled. */
export type AgentAutoResumeSnapshot = {
  entries: AgentAutoResumeEntry[]
}

export const AGENT_AUTO_RESUME_UPDATE_CHANNEL = 'agentAutoResume:update'
