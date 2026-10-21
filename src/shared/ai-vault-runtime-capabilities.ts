import { AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY } from './ai-vault-resume-preparation'

// Why: signals the host exposes the Agent Session History scanner over RPC
// (aiVault.listSessions). Registered unconditionally for every build, so it is a
// STATIC capability advertised by getStatus() automatically — NOT a runtime
// conditional like browser.headless.v1.
export const AI_VAULT_RUNTIME_CAPABILITY = 'aiVault.v1' as const
export const AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY = 'aiVault.session-titles.v1' as const

export const AI_VAULT_RUNTIME_CAPABILITIES = [
  AI_VAULT_RUNTIME_CAPABILITY,
  AI_VAULT_SESSION_TITLES_RUNTIME_CAPABILITY,
  AI_VAULT_CHAT_FORK_SOURCE_CAPABILITY
] as const
