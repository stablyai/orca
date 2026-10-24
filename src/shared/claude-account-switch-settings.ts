/** What a Claude account switch does to Claude sessions still on the old account. */
export type ClaudeAccountSwitchRunningSessions = 'ask' | 'restart' | 'keep'

export type ClaudeAccountSwitchSettings = {
  /** Absent means 'ask'. */
  claudeAccountSwitchRunningSessions?: ClaudeAccountSwitchRunningSessions
  /** When true, projects without a saved Claude account prompt for one before launching Claude. */
  askClaudeAccountPerProject?: boolean
}
