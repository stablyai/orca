export const CODEX_RESET_CREDIT_RUNTIME_CAPABILITY = 'accounts.codex-reset-credit.v1' as const
export const ACCOUNT_IMPORT_RUNTIME_CAPABILITY = 'accounts.import-host-credentials.v1' as const
// Why: `orca account add claude` signs in to an account folder the host creates first.
export const CLAUDE_SIGN_IN_RUNTIME_CAPABILITY = 'accounts.claude-sign-in.v1' as const
export const ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY = 'accounts.antigravity-native.v1' as const
// Why separate: a host that serves the terminal accounts may predate the chat sign-in's methods.
export const ANTIGRAVITY_CHAT_SIGN_IN_RUNTIME_CAPABILITY =
  'accounts.antigravity-chat-sign-in.v1' as const
export const ANTIGRAVITY_CHAT_SIGN_IN_INTENT_RUNTIME_CAPABILITY =
  'accounts.antigravity-chat-sign-in-intent.v1' as const
export const ANTIGRAVITY_CHAT_AUTH_CONFIG_RUNTIME_CAPABILITY =
  'accounts.antigravity-chat-auth-config.v1' as const
// Why separate: older hosts reject the Gemini API key and Agent Platform account types.
export const ANTIGRAVITY_CHAT_KEY_AND_ADC_AUTH_RUNTIME_CAPABILITY =
  'accounts.antigravity-chat-auth-key-adc.v1' as const
// Why separate: older hosts lack the read that finds a host's Gemini API key and gcloud login.
export const ANTIGRAVITY_CHAT_AUTH_DETECT_RUNTIME_CAPABILITY =
  'accounts.antigravity-chat-auth-detect.v1' as const
// Why separate: older hosts reject a switch that says what to do with running agy terminals.
export const ANTIGRAVITY_RUNNING_TERMINALS_RUNTIME_CAPABILITY =
  'accounts.antigravity-running-terminals.v1' as const
export const DATA_ACCOUNT_RUNTIME_CAPABILITY = 'accounts.managed-data-profiles.v1' as const
// Why separate: hosts with these accounts may still refuse a phone's switch between them.
export const PHONE_PROVIDER_ACCOUNT_SWITCH_RUNTIME_CAPABILITY =
  'accounts.phone-provider-switch.v1' as const
// Why: MiniMax and GLM Coding Plan keys saved on the host its usage poller reads.
export const USAGE_CREDENTIALS_RUNTIME_CAPABILITY = 'accounts.usage-credentials.v1' as const
// Why: a paired client adds a Claude/Codex account whose login runs on this host (#20009).
export const HOST_ACCOUNT_SIGN_IN_RUNTIME_CAPABILITY = 'accounts.host-sign-in.v1' as const
// Why: older hosts drop an unknown accountId and would add a second account instead of re-authenticating.
export const HOST_ACCOUNT_REAUTH_RUNTIME_CAPABILITY = 'accounts.host-sign-in-reauth.v1' as const
// Why separate: the two above shipped before phones could call the sign-in; Windows hosts never advertise it.
export const MOBILE_HOST_ACCOUNT_SIGN_IN_RUNTIME_CAPABILITY =
  'accounts.mobile-host-sign-in.v1' as const

export const ACCOUNT_RUNTIME_CAPABILITIES = [
  ACCOUNT_IMPORT_RUNTIME_CAPABILITY,
  CLAUDE_SIGN_IN_RUNTIME_CAPABILITY,
  ANTIGRAVITY_ACCOUNTS_RUNTIME_CAPABILITY,
  ANTIGRAVITY_CHAT_SIGN_IN_RUNTIME_CAPABILITY,
  ANTIGRAVITY_CHAT_AUTH_CONFIG_RUNTIME_CAPABILITY,
  ANTIGRAVITY_CHAT_SIGN_IN_INTENT_RUNTIME_CAPABILITY,
  ANTIGRAVITY_CHAT_KEY_AND_ADC_AUTH_RUNTIME_CAPABILITY,
  ANTIGRAVITY_CHAT_AUTH_DETECT_RUNTIME_CAPABILITY,
  ANTIGRAVITY_RUNNING_TERMINALS_RUNTIME_CAPABILITY,
  DATA_ACCOUNT_RUNTIME_CAPABILITY,
  PHONE_PROVIDER_ACCOUNT_SWITCH_RUNTIME_CAPABILITY,
  CODEX_RESET_CREDIT_RUNTIME_CAPABILITY,
  USAGE_CREDENTIALS_RUNTIME_CAPABILITY,
  HOST_ACCOUNT_SIGN_IN_RUNTIME_CAPABILITY,
  HOST_ACCOUNT_REAUTH_RUNTIME_CAPABILITY,
  MOBILE_HOST_ACCOUNT_SIGN_IN_RUNTIME_CAPABILITY
] as const
