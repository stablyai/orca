import { clampUsedPercent } from '../../../../../shared/agent-usage/display/usage-percentage-display'

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

/** Grey fill for bars outside a provider's details card, where usage stays uncolored. */
export const PLAIN_USAGE_BAR_CLASS = 'bg-muted-foreground/40'

/**
 * 'health' colors the fill green/yellow/red by consumption (provider details card only);
 * 'plain' keeps it grey everywhere else.
 */
export type UsageBarTone = 'health' | 'plain'

export function usageBarClass(usedPercent: number, tone: UsageBarTone = 'health'): string {
  return tone === 'plain' ? PLAIN_USAGE_BAR_CLASS : BAR_CLASS[getUsageHealthTone(usedPercent)]
}
