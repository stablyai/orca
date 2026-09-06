// Why: agent types aren't a fixed set (custom agents exist); any non-empty string is
// accepted — these well-known names are just a convenience union for pattern-matching.
export type WellKnownAgentType =
  | 'claude'
  | 'openclaude'
  | 'codex'
  | 'gemini'
  | 'antigravity'
  | 'amp'
  | 'opencode'
  | 'mimo-code'
  | 'cursor'
  | 'copilot'
  | 'aider'
  | 'pi'
  | 'omp'
  | 'prime-agent'
  | 'droid'
  | 'command-code'
  | 'kimi'
  | 'grok'
  | 'hermes'
  | 'devin'
  | 'ante'
  | 'trae'
  | 'unknown'

export type AgentType = WellKnownAgentType | (string & {})
