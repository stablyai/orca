/** Orca's Claude status hooks as a plugin folder, for a Claude whose config folder Orca never hooked. */
export const CLAUDE_HOOK_PLUGIN_DIR_ENV = 'ORCA_CLAUDE_HOOK_PLUGIN_DIR'

export const CLAUDE_HOOK_PLUGIN_NAME = 'orca-status-hooks'

// Base64 of the fixed `$ProgressPreference='SilentlyContinue'; ` lead every Orca -EncodedCommand hook starts with.
const ORCA_ENCODED_HOOK_LEAD =
  'JABQAHIAbwBnAHIAZQBzAHMAUAByAGUAZgBlAHIAZQBuAGMAZQA9ACcAUwBpAGwAZQBuAHQAbAB5AEMAbwBuAHQAaQBuAHUAZQAnADsA'

/** Matches any Orca-managed hook command in a settings file: script paths with either separator (JSON-escaped), the native .exe, encoded PowerShell. */
export const CLAUDE_MANAGED_HOOK_COMMAND_PATTERN = String.raw`\.orca.{1,2}agent-hooks|orca-agent-hook\.exe|-EncodedCommand ${ORCA_ENCODED_HOOK_LEAD}`
