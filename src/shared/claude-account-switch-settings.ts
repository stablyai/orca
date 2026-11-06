export type ClaudeAccountSwitchRunningSessions = 'ask' | 'restart' | 'keep'

export type ClaudeAccountSwitchSettings = {
  /** Absent means 'ask'. */
  claudeAccountSwitchRunningSessions?: ClaudeAccountSwitchRunningSessions
  /** Opt-in: new Claude sessions move to the managed account with the most room before a usage limit; optional for legacy settings. */
  claudeAutoSwitchEnabled?: boolean
}
