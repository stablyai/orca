export type TuiAgent =
  | 'claude'
  | 'claude-agent-teams' // Claude Code Agent Teams via Orca native panes
  | 'codebuddy'
  | 'openclaude'
  | 'codex'
  | 'autohand'
  | 'opencode'
  | 'opencode2' // OpenCode 2 beta
  | 'mimo-code'
  | 'pi' // Pi (pi.dev)
  | 'omp' // OMP (omp.sh)
  | 'qoder'
  | 'qoder-cn' // Qoder CLI China
  | 'gemini'
  | 'antigravity'
  | 'aider'
  | 'goose'
  | 'amp'
  | 'kilo' // Kilocode
  | 'kiro'
  | 'crush' // Charm/Crush
  | 'aug' // Augment/Auggie
  | 'cline' // Cline
  | 'codebuff'
  | 'freebuff'
  | 'command-code'
  | 'continue'
  | 'cursor'
  | 'droid' // Factory Droid
  | 'kimi'
  | 'mistral-vibe'
  | 'qwen-code'
  | 'rovo' // Rovo Dev
  | 'hermes' // Hermes Agent
  | 'openclaw'
  | 'copilot'
  | 'grok'
  | 'devin'
  | 'ante' // Ante (Antigma Labs)
  | 'trae'
  | 'muse' // Muse (Meta `muse` CLI)
  | 'zcode' // ZCode (Z.ai `zcode` CLI)
  | 'prime-agent' // Prime Agent (Prime Intellect)
  | 'dsh' // DeepSeek Harness (`dsh`, launched through its `dsh-tui` terminal profile)
  | 'jcode'

/** A named launch setup of a built-in agent. It starts the base agent's CLI with its own command,
 *  arguments and environment, and keeps the base agent's identity for hooks, status and history. */
export type AgentCopy = {
  /** `<base>.<slug>`: no built-in id has a dot, so a copy never collides with one. */
  id: string
  name: string
  agent: TuiAgent
  /** Absent runs the base agent's stock binary. */
  command?: string
  /** Absent means the base agent's untouched default; an empty string means no arguments. */
  args?: string
  /** Absent means the base agent's untouched default; an empty map means none. */
  env?: Record<string, string>
}
