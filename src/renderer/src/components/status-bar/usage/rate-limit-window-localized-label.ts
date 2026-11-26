import { getIntlLocale, translate } from '@/i18n/i18n'
import { formatLocalizedResetDuration, validResetAt } from './usage-reset-caption'
import { formatWindowLabel as formatSharedWindowLabel } from '../../../../../shared/agent-usage/rate-limits/rate-limit-window-label'

const WEEK_MINUTES = 60 * 24 * 7

// Why: shared formatting stays English for mobile; only the week unit has desktop copy.
export function formatWindowLabel(windowMinutes: number): string {
  if (windowMinutes === WEEK_MINUTES) {
    return translate('auto.components.status.bar.StatusBar.5c938d39ac', 'wk')
  }
  if (windowMinutes > WEEK_MINUTES && windowMinutes % WEEK_MINUTES === 0) {
    return translate('auto.components.status.bar.StatusBar.windowWeeks', '{{value0}}wk', {
      value0: windowMinutes / WEEK_MINUTES
    })
  }
  return formatSharedWindowLabel(windowMinutes)
}

export function formatRateLimitWindowChipLabel(
  window: { windowMinutes: number; resetsAt: number | null },
  now: number = Date.now()
): string {
  const resetsAt = validResetAt(window.resetsAt)
  if (resetsAt != null) {
    // Why: same units as the usage menu's reset column, so "19h 3m" never sits beside "19시간 3분".
    return (
      formatLocalizedResetDuration(resetsAt, now, getIntlLocale()) ??
      translate('auto.components.status.bar.InlineUsageBars.now', 'now')
    )
  }
  return formatWindowLabel(window.windowMinutes)
}
