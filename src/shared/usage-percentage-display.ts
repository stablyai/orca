export type UsagePercentageDisplay = 'used' | 'remaining'

// Why: missing settings preserve the consumption-meter behavior introduced in #8167.
export const DEFAULT_USAGE_PERCENTAGE_DISPLAY: UsagePercentageDisplay = 'used'

export function normalizeUsagePercentageDisplay(value: unknown): UsagePercentageDisplay {
  return value === 'used' || value === 'remaining' ? value : DEFAULT_USAGE_PERCENTAGE_DISPLAY
}

// Why: single clamp+round for bar width and label so the status bar and tooltip
// share one rounding, and feeding it into getDisplayedUsagePercentage stays a
// no-op — a pre-clamped value and a raw one resolve identically (#7574).
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
  // Why: round the used value *before* taking the `remaining` complement so the
  // result is stable whether the caller passes a raw usedPercent (compact status
  // bar) or one already through clampUsedPercent (tooltip). Rounding after the
  // complement makes `Math.round(100 - 20.5)` (80) disagree with the pre-rounded
  // `100 - Math.round(20.5)` (79) at a .5 fraction — the 1% drift in #7574.
  const roundedUsedPercent = Math.round(boundedUsedPercent)
  return display === 'used' ? roundedUsedPercent : 100 - roundedUsedPercent
}
