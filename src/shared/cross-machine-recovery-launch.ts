export const MAX_RECOVERY_APPEND_SYSTEM_PROMPT_BYTES = 16 * 1024

/** Per-session launch additions cc-sync supplies at import, keyed by source provider session id. */
export type RecoveryLaunchOverride = { appendSystemPrompt: string }
