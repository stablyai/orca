import { AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY } from './ai-vault-resume-preparation'

// aiVault.listSessions is unconditional, so getStatus advertises this statically rather than as a runtime-dependent capability.
export const AI_VAULT_RUNTIME_CAPABILITY = 'aiVault.v1' as const
export const AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY = 'aiVault.session-titles.v1' as const

export const AI_VAULT_RUNTIME_CAPABILITIES = [
  AI_VAULT_RUNTIME_CAPABILITY,
  AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY,
  AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY
] as const
