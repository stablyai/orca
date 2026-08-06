export type StatusBarUsageMode = 'verbose' | 'compact'

export const DEFAULT_STATUS_BAR_USAGE_MODE: StatusBarUsageMode = 'verbose'

export function normalizeStatusBarUsageMode(value: unknown): StatusBarUsageMode {
  return value === 'verbose' || value === 'compact' ? value : DEFAULT_STATUS_BAR_USAGE_MODE
}
