export type UsagePercentageDisplay = 'used' | 'remaining'

// Why: missing settings preserve the consumption-meter behavior introduced in #8167.
export const DEFAULT_USAGE_PERCENTAGE_DISPLAY: UsagePercentageDisplay = 'used'

export function normalizeUsagePercentageDisplay(value: unknown): UsagePercentageDisplay {
  return value === 'used' || value === 'remaining' ? value : DEFAULT_USAGE_PERCENTAGE_DISPLAY
}

export function getDisplayedUsagePercentage(
  usedPercent: number,
  display: UsagePercentageDisplay
): number {
  if (!Number.isFinite(usedPercent)) {
    // Why: invalid provider data must not be presented as 100% remaining capacity.
    return 0
  }
  const boundedUsedPercent = Math.min(100, Math.max(0, usedPercent))
  const percentage = display === 'used' ? boundedUsedPercent : 100 - boundedUsedPercent
  return Math.round(percentage)
}
