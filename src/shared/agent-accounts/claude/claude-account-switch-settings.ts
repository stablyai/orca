export const CLAUDE_ACCOUNT_SWITCH_RUNNING_SESSIONS = ['ask', 'restart', 'keep'] as const

export type ClaudeAccountSwitchRunningSessions =
  (typeof CLAUDE_ACCOUNT_SWITCH_RUNNING_SESSIONS)[number]

export type ClaudeAccountSwitchSettings = {
  /** Absent means 'ask'. */
  claudeAccountSwitchRunningSessions?: ClaudeAccountSwitchRunningSessions
}
