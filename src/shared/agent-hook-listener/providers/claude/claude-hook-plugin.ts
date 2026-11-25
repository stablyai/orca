/** Orca's Claude status hooks as a plugin folder, for a Claude whose config folder Orca never hooked. */
export const CLAUDE_HOOK_PLUGIN_DIR_ENV = 'ORCA_CLAUDE_HOOK_PLUGIN_DIR'

export const CLAUDE_HOOK_PLUGIN_NAME = 'orca-status-hooks'

/** Matches every form of Orca's managed Claude hook command in a settings file (.sh, .cmd, native .exe), not openclaude-hook. No backslash in brackets: fish single quotes would fold it. */
export const CLAUDE_MANAGED_HOOK_COMMAND_PATTERN = String.raw`[^A-Za-z]claude-hook\.(sh|cmd)|orca-agent-hook\.exe`
