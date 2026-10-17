/** What an account switch does to that agent's sessions still on the old account. */
export type AccountSwitchRunningSessions = 'ask' | 'restart' | 'keep'

export type AgentAccountSwitchSettings = {
  /** Absent means 'ask'. */
  claudeAccountSwitchRunningSessions?: AccountSwitchRunningSessions
  /** Absent means 'ask'. */
  codexAccountSwitchRunningSessions?: AccountSwitchRunningSessions
}
