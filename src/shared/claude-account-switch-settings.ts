export type ClaudeAccountSwitchRunningSessions = 'ask' | 'restart' | 'keep'

/** Absent or any value other than true leaves idle-account token refresh off. */
export function claudeAccountTokenRefreshEnabled(
  settings: { claudeAccountTokenRefresh?: boolean } | null | undefined
): boolean {
  return settings?.claudeAccountTokenRefresh === true
}

export type ClaudeAccountSwitchSettings = {
  /** Absent means 'ask'. */
  claudeAccountSwitchRunningSessions?: ClaudeAccountSwitchRunningSessions
  /** Opt-in: new Claude sessions move to the managed account with the most room before a usage limit; optional for legacy settings. */
  claudeAutoSwitchEnabled?: boolean
  /** Absent means off. Only an explicit true refreshes idle Claude accounts' access tokens. */
  claudeAccountTokenRefresh?: boolean
}
