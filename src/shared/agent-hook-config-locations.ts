import type { AgentHookTarget } from './agent-hook-types'

// Display approximations for the file each managed hook install touches, for UI that has to tell
// the user what gets written. Not authoritative: `devin` diverges on Windows
// (%APPDATA%\devin\config.json), and claude/grok/copilot/kimi/hermes honour env home overrides.
// The real resolver is `getConfigPath()` in each `src/main/<agent>/hook-service.ts`.
// Keyed by AgentHookTarget so a new target fails typecheck until someone supplies a location.
export const AGENT_HOOK_CONFIG_LOCATIONS: Readonly<Record<AgentHookTarget, string | null>> = {
  claude: '~/.claude/settings.json',
  openclaude: '~/.openclaude/settings.json',
  codex: null, // Orca manages its own Codex home, so there is no stable literal path to show.
  gemini: '~/.gemini/settings.json',
  antigravity: '~/.gemini/config/hooks.json',
  amp: '~/.config/amp/plugins/orca-agent-status.ts',
  cursor: '~/.cursor/hooks.json',
  droid: '~/.factory/settings.json',
  'command-code': '~/.commandcode/settings.json',
  grok: '$GROK_HOME/hooks/orca-status.json',
  copilot: '$COPILOT_HOME/hooks/orca.json',
  hermes: '$HERMES_HOME/config.yaml',
  devin: '~/.config/devin/config.json',
  kimi: '$KIMI_CODE_HOME/config.toml'
}
