/** The closed set of built-in AI coding agents Orca knows how to launch. Static behavior
 *  registries (launch config, display names, telemetry kind, permissions, mobile parity)
 *  are keyed by this union only. Extend it as new built-in agents are added. */
export type BuiltInTuiAgent =
  | 'claude' // Claude Code
  | 'claude-agent-teams' // Claude Code Agent Teams via Orca native panes
  | 'openclaude' // OpenClaude
  | 'codex' // OpenAI Codex
  | 'autohand' // Autohand Code CLI
  | 'opencode' // OpenCode
  | 'mimo-code'
  | 'pi' // Pi (pi.dev)
  | 'omp' // OMP (omp.sh)
  | 'gemini' // Gemini CLI
  | 'antigravity' // Google Antigravity CLI
  | 'aider' // Aider
  | 'goose' // Goose
  | 'amp' // Amp
  | 'kilo' // Kilocode
  | 'kiro' // Kiro
  | 'crush' // Charm/Crush
  | 'aug' // Augment/Auggie
  | 'cline' // Cline
  | 'codebuff' // Codebuff
  | 'command-code' // Command Code
  | 'continue' // Continue
  | 'cursor' // Cursor
  | 'droid' // Factory Droid
  | 'kimi' // Kimi
  | 'mistral-vibe' // Mistral Vibe
  | 'qwen-code' // Qwen Code
  | 'rovo' // Rovo Dev
  | 'hermes' // Hermes Agent
  | 'openclaw' // OpenClaw
  | 'copilot' // GitHub Copilot CLI
  | 'grok' // xAI Grok CLI
  | 'devin' // Devin CLI
  | 'ante' // Ante (Antigma Labs)
  | 'trae' // Trae CLI
  | 'prime-agent' // Prime Agent (Prime Intellect)

/** Durable identity of a user-defined agent derived from a built-in base harness.
 *  Newly minted suffixes are canonical lowercase RFC 4122 UUIDs; ids are never reused. */
export type CustomTuiAgentId = `custom-agent:${BuiltInTuiAgent}:${string}`

/** Any agent identity a launch surface may request: a built-in or a custom derivative.
 *  Dynamic identity collections (defaults, disabled lists, quick commands, sessions) use
 *  this union; static behavior registries stay keyed by `BuiltInTuiAgent` and dynamic
 *  values must resolve through the catalog identity accessor first. */
export type TuiAgent = BuiltInTuiAgent | CustomTuiAgentId

export type CustomTuiAgent = {
  id: CustomTuiAgentId
  baseAgent: BuiltInTuiAgent
  label: string
  /** One executable argv element replacing the whole base command prefix; never reparsed. */
  commandOverride?: string
  /** Freeform args template in the shell-independent v1 grammar (tokenized before interpolation). */
  args: string
  env: Record<string, string>
  /** Whether launches started from paired devices may use this agent's env values on the host. */
  syncEnv: boolean
}

/** Tombstone kept while any persisted owner still references the deleted id. It carries
 *  identity/label only — args, env, and executable override are never recoverable. */
export type DeletedCustomTuiAgent = {
  id: CustomTuiAgentId
  baseAgent: BuiltInTuiAgent
  label: string
  deletedAt: number
}
