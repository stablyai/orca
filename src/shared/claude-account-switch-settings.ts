export type ClaudeAccountSwitchRunningSessions = 'ask' | 'restart' | 'keep'

export type ClaudeAccountSwitchSettings = {
  /** Absent means 'ask'. */
  claudeAccountSwitchRunningSessions?: ClaudeAccountSwitchRunningSessions
  /** Opt-in: before a usage limit, new Claude sessions move to the account with the most room. */
  claudeAutoSwitchEnabled?: boolean
}
