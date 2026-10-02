import type { PersistedUIState } from './persisted-ui-state-types'
import { DEFAULT_CLAUDE_COMPACT_METRIC } from './claude-compact-metric'
import { DEFAULT_STATUS_BAR_USAGE_MODE } from './status-bar-usage-mode'
import { DEFAULT_USAGE_PERCENTAGE_DISPLAY } from './usage-percentage-display'

export const DEFAULT_STATUS_BAR_UI_STATE = {
  usagePercentageDisplay: DEFAULT_USAGE_PERCENTAGE_DISPLAY,
  statusBarUsageMode: DEFAULT_STATUS_BAR_USAGE_MODE,
  claudeCompactMetric: DEFAULT_CLAUDE_COMPACT_METRIC
} satisfies Pick<
  PersistedUIState,
  'usagePercentageDisplay' | 'statusBarUsageMode' | 'claudeCompactMetric'
>
