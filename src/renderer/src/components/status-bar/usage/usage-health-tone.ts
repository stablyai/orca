import { clampUsedPercent } from '../../../../../shared/usage-percentage-display'

/** Used % at which usage turns yellow (20% or less left). */
export const USAGE_WARNING_PERCENT = 80
/** Used % at which usage turns red (10% or less left). */
export const USAGE_URGENT_PERCENT = 90

export type UsageHealthTone = 'healthy' | 'warning' | 'urgent'

/** Tone always follows consumption, whichever percentage the user chose to display. */
export function getUsageHealthTone(usedPercent: number): UsageHealthTone {
  const used = clampUsedPercent(usedPercent)
  if (used >= USAGE_URGENT_PERCENT) {
    return 'urgent'
  }
  if (used >= USAGE_WARNING_PERCENT) {
    return 'warning'
  }
  return 'healthy'
}

const BAR_CLASS: Record<UsageHealthTone, string> = {
  healthy: 'bg-emerald-600 dark:bg-emerald-500',
  // Why 600 in light: yellow-500 barely separates from the light track.
  warning: 'bg-yellow-600 dark:bg-yellow-500',
  urgent: 'bg-red-500'
}

// Why the light-mode shades: small text on light popovers needs 4.5:1.
const TEXT_CLASS: Record<UsageHealthTone, string> = {
  healthy: 'text-emerald-700 dark:text-emerald-400',
  warning: 'text-yellow-700 dark:text-yellow-400',
  urgent: 'text-red-600 dark:text-red-400'
}

export function usageBarClass(usedPercent: number): string {
  return BAR_CLASS[getUsageHealthTone(usedPercent)]
}

export function usageTextClass(usedPercent: number): string {
  return TEXT_CLASS[getUsageHealthTone(usedPercent)]
}
