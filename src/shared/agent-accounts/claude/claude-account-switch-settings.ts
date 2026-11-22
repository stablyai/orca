export type ClaudeAccountSwitchRunningSessions = 'ask' | 'restart' | 'keep'

export type ClaudeAccountSwitchSettings = {
  /** Absent means 'ask'. */
  claudeAccountSwitchRunningSessions?: ClaudeAccountSwitchRunningSessions
  /** Absent means off. */
  claudeAccountAutoSwitchAtLimit?: boolean
  /** Usage percent that triggers the switch; absent means 95. */
  claudeAccountAutoSwitchThresholdPercent?: number
}
