import type { ClaudeAccountSwitchRunningSessions } from '../claude/claude-account-switch-settings'

export type AntigravityAccountSwitchSettings = {
  /** What a switch of agy's login does with agy running in terminals; absent means 'ask'. */
  antigravityAccountSwitchRunningSessions?: ClaudeAccountSwitchRunningSessions
}
