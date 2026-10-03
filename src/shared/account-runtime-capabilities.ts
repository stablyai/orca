export const CODEX_RESET_CREDIT_RUNTIME_CAPABILITY = 'accounts.codex-reset-credit.v1' as const
export const ACCOUNT_IMPORT_RUNTIME_CAPABILITY = 'accounts.import-host-credentials.v1' as const
export const CODEX_ACCOUNT_IMPORT_CAPABILITY = 'accounts.import-codex-home.v1' as const
export const CLAUDE_PROFILE_LOGIN_CAPABILITY = 'accounts.claude-profile-login.v1' as const

export const ACCOUNT_RUNTIME_CAPABILITIES = [
  CODEX_ACCOUNT_IMPORT_CAPABILITY,
  CLAUDE_PROFILE_LOGIN_CAPABILITY,
  CODEX_RESET_CREDIT_RUNTIME_CAPABILITY
] as const
