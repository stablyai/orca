import { AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY } from './ai-vault-resume-preparation'

// aiVault.listSessions is unconditional, so getStatus advertises this statically rather than as a runtime-dependent capability.
export const AI_VAULT_RUNTIME_CAPABILITY = 'aiVault.v1' as const
export const AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY = 'aiVault.session-titles.v1' as const
export const AI_VAULT_SELECTED_SESSION_RUNTIME_CAPABILITY = 'aiVault.selected-session.v1' as const
/** The host deletes its own history rows through aiVault.deleteSession. */
export const AI_VAULT_DELETE_SESSION_RUNTIME_CAPABILITY = 'aiVault.delete-session.v1' as const

/** Older hosts may annotate canonical history ownership. */
export const AI_VAULT_CANONICAL_PROJECT_SEARCH_CAPABILITY =
  'aiVault.search.canonical-project.v1' as const

export const AI_VAULT_RUNTIME_CAPABILITIES = [
  AI_VAULT_RUNTIME_CAPABILITY,
  AI_VAULT_SELECTED_SESSION_RUNTIME_CAPABILITY,
  AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY,
  AI_VAULT_DELETE_SESSION_RUNTIME_CAPABILITY,
  AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY
] as const
