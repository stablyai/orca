export type ClaudeAccountSwitchRunningSessions = 'ask' | 'restart' | 'keep'

/** Usage left, in percent, below which the selected account is switched away from. */
export const DEFAULT_CLAUDE_AUTO_SWITCH_MIN_SESSION_HEADROOM = 8
export const DEFAULT_CLAUDE_AUTO_SWITCH_MIN_WEEKLY_HEADROOM = 3

export type ClaudeAccountSwitchSettings = {
  /** Absent means 'ask'. */
  claudeAccountSwitchRunningSessions?: ClaudeAccountSwitchRunningSessions
  /** Absent means off. */
  claudeAccountAutoSwitch?: boolean
  /** Percent of the 5-hour window left; absent means the default. */
  claudeAccountAutoSwitchMinSessionHeadroom?: number
  /** Percent of the weekly window left; absent means the default. */
  claudeAccountAutoSwitchMinWeeklyHeadroom?: number
}
