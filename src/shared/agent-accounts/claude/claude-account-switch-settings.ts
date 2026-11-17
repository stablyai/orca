export type ClaudeAccountSwitchRunningSessions = 'ask' | 'restart' | 'restart-all' | 'keep'

export type ClaudeAccountSwitchSettings = {
  /** Absent means 'ask'. */
  claudeAccountSwitchRunningSessions?: ClaudeAccountSwitchRunningSessions
}
