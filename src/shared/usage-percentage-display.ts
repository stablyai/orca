export type UsagePercentageDisplay = 'used' | 'remaining'

// Why: missing settings preserve the consumption-meter behavior introduced in #8167.
export const DEFAULT_USAGE_PERCENTAGE_DISPLAY: UsagePercentageDisplay = 'used'

export function normalizeUsagePercentageDisplay(value: unknown): UsagePercentageDisplay {
  return value === 'used' || value === 'remaining' ? value : DEFAULT_USAGE_PERCENTAGE_DISPLAY
}

// Share clamp/round for bar and label; finite raw and pre-clamped inputs then display identically (#7574).
export function clampUsedPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) {
    return 0
  }
  return Math.max(0, Math.min(100, Math.round(usedPercent)))
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
  // Round used before complementing so raw and pre-rounded inputs agree: 20.5 becomes 79 remaining, not 80 (#7574).
  const roundedUsedPercent = Math.round(boundedUsedPercent)
  return display === 'used' ? roundedUsedPercent : 100 - roundedUsedPercent
}
