export type ClaudeAccountSwitchRunningSessions = 'ask' | 'restart' | 'keep'

/** Absent or any value other than true leaves the auth proxy off. */
export function claudeAuthProxyEnabled(
  settings: { claudeAuthProxy?: boolean } | null | undefined
): boolean {
  return settings?.claudeAuthProxy === true
}

export type ClaudeAccountSwitchSettings = {
  /** Absent means 'ask'. */
  claudeAccountSwitchRunningSessions?: ClaudeAccountSwitchRunningSessions
  /** Opt-in: new Claude sessions move to the managed account with the most room before a usage limit; optional for legacy settings. */
  claudeAutoSwitchEnabled?: boolean
  /** Absent means off. Only an explicit true turns the proxy on. */
  claudeAuthProxy?: boolean
}
