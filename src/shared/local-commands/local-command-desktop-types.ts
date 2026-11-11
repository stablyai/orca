/** Main ↔ renderer shapes for local commands. Main holds every request; the renderer only shows and answers. */

export const LOCAL_COMMANDS_PROMPTS_CHANNEL = 'localCommands:prompts'
export const LOCAL_COMMANDS_STATE_CHANNEL = 'localCommands:stateChanged'

export type LocalCommandDecision = 'allow-once' | 'always-allow' | 'deny'

/** A request waiting for this person. Everything here except `reason` and `agent` is checked by main. */
export type LocalCommandPrompt = {
  id: string
  sandboxId: string
  workspaceLabel: string
  shared: boolean
  command: string
  /** The resolved folder on this computer the command runs in. */
  cwd: string
  timeoutSec: number
  /** Agent text: show quoted and muted. */
  reason: string | null
  agent: string | null
  /** Lookalike letters can make a command read as something else. */
  hasNonAscii: boolean
  /** Downloads or builds a script and runs it (`curl … | sh`). */
  pipesToShell: boolean
  /** Only Allow once is offered: lookalikes, pipe-to-shell, sudo or command substitution. */
  alwaysAllowBlocked: boolean
  /** Epoch ms on this computer's clock. */
  expiresAt: number
}

export type LocalCommandWorkspaceRow = {
  sandboxId: string
  label: string
  enabled: boolean
  /** The owner chose to allow it while teammates share the workspace. */
  sharedAllowed: boolean
  /** From the Orca Cloud registry; null until it answers. */
  shared: boolean | null
  isOwner: boolean | null
  /** An attach stream is open to the workspace right now. */
  connected: boolean
}

export type LocalCommandAllowRule = {
  id: string
  sandboxId: string
  workspaceLabel: string
  command: string
  cwd: string
  createdAt: number
}

export type LocalCommandAuditOutcome =
  | 'allowed-once'
  | 'always-allowed'
  /** Matched an "Always allow" rule; no prompt was shown. */
  | 'auto-allowed'
  | 'denied'
  | 'timed-out'
  /** This computer's rules refused it (turned off, not the owner, shared, invalid request). */
  | 'refused'
  /** Settled on another computer or by the workspace before this one answered. */
  | 'closed'

export type LocalCommandAuditEntry = {
  at: number
  requestId: string
  sandboxId: string
  workspaceLabel: string
  /** The first 1,000 characters for a longer command; then the length and hash identify it. */
  command: string
  commandLength?: number
  commandSha256?: string
  cwd: string | null
  agent: string | null
  outcome: LocalCommandAuditOutcome
  detail?: string
  exitCode?: number | null
  signal?: string | null
  timedOut?: boolean
  durationMs?: number
  stdoutBytes?: number
  stderrBytes?: number
  truncated?: boolean
}

export type LocalCommandsState = {
  /** False on platforms or builds without local commands (no Orca Cloud, Windows). */
  available: boolean
  workspaces: LocalCommandWorkspaceRow[]
  rules: LocalCommandAllowRule[]
}

export type LocalCommandSetEnabledRequest = {
  sandboxId: string
  enabled: boolean
  /** Required to turn it on while teammates share the workspace. */
  allowShared?: boolean
}
