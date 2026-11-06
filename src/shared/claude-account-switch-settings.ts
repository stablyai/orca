export type ClaudeAccountSwitchRunningSessions = 'ask' | 'restart' | 'keep'

/** Absent or any value other than true leaves the auth proxy off. */
export function claudeAuthProxyEnabled(
  settings: { claudeAuthProxy?: boolean } | null | undefined
): boolean {
  return settings?.claudeAuthProxy === true
}
/** What the host does with a running Claude session whose own account nears a usage limit. */
export type ClaudeSessionMoverSetting = 'off' | 'ask' | 'move'

export type ClaudeAccountSwitchSettings = {
  /** Absent means 'ask'. */
  claudeAccountSwitchRunningSessions?: ClaudeAccountSwitchRunningSessions
  /** Opt-in: new Claude sessions move to the managed account with the most room before a usage limit; optional for legacy settings. */
  claudeAutoSwitchEnabled?: boolean
  /** Absent means off. Only an explicit true turns the proxy on. */
  claudeAuthProxy?: boolean
  /** Absent means 'ask'. A headless host treats 'ask' as 'move'. */
  claudeSessionMover?: ClaudeSessionMoverSetting
}
