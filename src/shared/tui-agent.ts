/** All AI coding agents Orca knows how to launch. Used for the agent picker in the new-workspace
 *  flow and for the default-agent setting. Extend this union as new agents are added. */
export type TuiAgent =
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
