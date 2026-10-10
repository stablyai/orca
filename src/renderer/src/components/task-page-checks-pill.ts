import { getProviderChecksLabel } from '../../../shared/provider-check-summary'
import type { ProviderCheckSummary } from '../../../shared/github/pull-request-types'

type ChecksPillItem = { checksSummary?: ProviderCheckSummary }

/**
 * The Tasks-grid checks pill. Label and tone both read the one shared summary so the pill can never
 * contradict its own colour — a green pill used to read "1 unresolved" whenever neutral > 0.
 */
export function getChecksLabel(item: ChecksPillItem): string {
  return getProviderChecksLabel(item.checksSummary)
}

export function getChecksPillTone(item: ChecksPillItem): string {
  const state = item.checksSummary?.state
  if (state === 'success') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200'
  }
  if (state === 'failure') {
    return 'border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-200'
  }
  if (state === 'pending') {
    return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200'
  }
  return 'border-border/60 bg-background/70 text-muted-foreground'
}
