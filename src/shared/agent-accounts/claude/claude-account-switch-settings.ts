export type ClaudeAccountSwitchRunningSessions = 'ask' | 'restart' | 'keep'

export type ClaudeAccountSwitchSettings = {
  /** Absent means 'ask'. */
  claudeAccountSwitchRunningSessions?: ClaudeAccountSwitchRunningSessions
  /** Switch Claude accounts automatically when the active one nears its limit. */
  claudeAutoSwitch?: { enabled: boolean; threshold: number }
  /** Per-account rules; threshold in percent (50-99.9), higher priority is used first. */
  claudeAccountRotation?: Record<
    string,
    { disabled?: boolean; threshold?: number; priority?: number }
  >
}

export const DEFAULT_AUTO_SWITCH_THRESHOLD = 90
