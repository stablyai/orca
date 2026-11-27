import { AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY } from '../resume/ai-vault-resume-preparation'

// aiVault.listSessions is unconditional, so getStatus advertises this statically rather than as a runtime-dependent capability.
export const AI_VAULT_RUNTIME_CAPABILITY = 'aiVault.v1' as const
export const AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY = 'aiVault.session-titles.v1' as const
export const AI_VAULT_SESSION_TITLE_REFRESH_RUNTIME_CAPABILITY =
  'aiVault.session-title-refresh.v1' as const
/** The host deletes its own history rows through aiVault.deleteSession. */
export const AI_VAULT_DELETE_SESSION_RUNTIME_CAPABILITY = 'aiVault.delete-session.v1' as const
/** The host builds History hand-off prompts through aiVault.prepareSessionHandoffPrompt. */
export const AI_VAULT_SESSION_HANDOFF_RUNTIME_CAPABILITY = 'aiVault.session-handoff.v1' as const

/** Sent by a client that counts `hiddenRowCount` toward History depth, so the host may list each chat once. */
export const AI_VAULT_CHAT_ROWS_CLIENT_CAPABILITY = 'aiVault.chat-rows.v1' as const

export const AI_VAULT_RUNTIME_CAPABILITIES = [
  AI_VAULT_RUNTIME_CAPABILITY,
  AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY,
  AI_VAULT_SESSION_TITLE_REFRESH_RUNTIME_CAPABILITY,
  AI_VAULT_DELETE_SESSION_RUNTIME_CAPABILITY,
  AI_VAULT_SESSION_HANDOFF_RUNTIME_CAPABILITY,
  AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY
] as const
