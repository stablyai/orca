export type StatusBarUsageWindows = 'session' | 'weekly' | 'both'

export const DEFAULT_STATUS_BAR_USAGE_WINDOWS: StatusBarUsageWindows = 'both'

export function normalizeStatusBarUsageWindows(value: unknown): StatusBarUsageWindows {
  return value === 'session' || value === 'weekly' ? value : DEFAULT_STATUS_BAR_USAGE_WINDOWS
}
