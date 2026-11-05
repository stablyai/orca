export const CODEX_RESET_CREDIT_RUNTIME_CAPABILITY = 'accounts.codex-reset-credit.v1' as const
export const ACCOUNT_IMPORT_RUNTIME_CAPABILITY = 'accounts.import-host-credentials.v1' as const
// Why: `orca account add claude` signs in to an account folder the host creates first.
export const CLAUDE_SIGN_IN_RUNTIME_CAPABILITY = 'accounts.claude-sign-in.v1' as const
export const ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY = 'accounts.antigravity-native.v1' as const
// Why separate: a host that serves the terminal accounts may predate the chat sign-in's methods.
export const ANTIGRAVITY_CHAT_SIGN_IN_RUNTIME_CAPABILITY =
  'accounts.antigravity-chat-sign-in.v1' as const
export const DATA_ACCOUNT_RUNTIME_CAPABILITY = 'accounts.managed-data-profiles.v1' as const
// Why: MiniMax and GLM Coding Plan keys saved on the host its usage poller reads.
export const USAGE_CREDENTIALS_RUNTIME_CAPABILITY = 'accounts.usage-credentials.v1' as const
// Why: a paired client adds a Claude/Codex account whose login runs on this host (#20009).
export const HOST_ACCOUNT_SIGN_IN_RUNTIME_CAPABILITY = 'accounts.host-sign-in.v1' as const

export const ACCOUNT_RUNTIME_CAPABILITIES = [
  ACCOUNT_IMPORT_RUNTIME_CAPABILITY,
  CLAUDE_SIGN_IN_RUNTIME_CAPABILITY,
  ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY,
  ANTIGRAVITY_CHAT_SIGN_IN_RUNTIME_CAPABILITY,
  DATA_ACCOUNT_RUNTIME_CAPABILITY,
  CODEX_RESET_CREDIT_RUNTIME_CAPABILITY,
  USAGE_CREDENTIALS_RUNTIME_CAPABILITY,
  HOST_ACCOUNT_SIGN_IN_RUNTIME_CAPABILITY
] as const
