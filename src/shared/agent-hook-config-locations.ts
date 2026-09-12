import type { AgentHookTarget } from './agent-hook-types'

// Display approximations for the file each managed hook install touches, for UI that has to tell
// the user what gets written. Not authoritative: claude/grok/copilot/kimi/hermes honour env home
// overrides, so those show the variable rather than a resolved path.
// The real resolver is `getConfigPath()` in each `src/main/<agent>/hook-service.ts`.
// Keyed by AgentHookTarget so a new target fails typecheck until someone supplies a location.
// Why a function of platform: `devin` is the one target whose real resolver branches on platform
// (`getDevinConfigPath`, src/main/devin/hook-settings.ts), and a disclosure surface that shows a
// Windows user the POSIX path is simply wrong. Taking the platform here keeps every future
// divergence in one place instead of special-cased at the call site.
export function getAgentHookConfigLocations(
  platform: NodeJS.Platform
): Readonly<Record<AgentHookTarget, string>> {
  return {
    claude: '~/.claude/settings.json',
    openclaude: '~/.openclaude/settings.json',
    // Two lanes: Orca's own Codex home, or — when the host's real home is the selected one — the
    // user's ~/.codex, where the install also adds a trust entry to config.toml.
    codex: '~/.codex/hooks.json + config.toml, or the Orca-managed Codex home',
    gemini: '~/.gemini/settings.json',
    antigravity: '~/.gemini/config/hooks.json',
    amp: '~/.config/amp/plugins/orca-agent-status.ts',
    cursor: '~/.cursor/hooks.json',
    droid: '~/.factory/settings.json',
    'command-code': '~/.commandcode/settings.json',
    grok: '$GROK_HOME/hooks/orca-status.json',
    copilot: '$COPILOT_HOME/hooks/orca.json',
    hermes: '$HERMES_HOME/config.yaml',
    devin: platform === 'win32' ? '%APPDATA%\\devin\\config.json' : '~/.config/devin/config.json',
    kimi: '$KIMI_CODE_HOME/config.toml'
  }
}
