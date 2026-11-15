import type { Translate } from '@/i18n/use-translate'
import { uiNumberFormat } from '@/i18n/ui-intl-formatters'
import { formatUiNarrowDuration } from '@/i18n/relative-time-format'
import { formatResetDuration } from '../../../../../shared/agent-usage/rate-limits/rate-limit-reset-format'

const RESET_UNIT_FORMATS: Record<'minute' | 'hour' | 'day', Intl.NumberFormatOptions> = {
  minute: { style: 'unit', unit: 'minute', unitDisplay: 'short' },
  hour: { style: 'unit', unit: 'hour', unitDisplay: 'short' },
  day: { style: 'unit', unit: 'day', unitDisplay: 'short' }
}

export function validResetAt(resetsAt: number | null | undefined): number | null {
  return resetsAt != null && Number.isFinite(new Date(resetsAt).getTime()) ? resetsAt : null
}

/** Locale-aware "3h 35m"; null when the reset is unknown or already passed. */
export function formatLocalizedResetDuration(
  resetsAt: number | null | undefined,
  now: number,
  intlLocale: string
): string | null {
  const at = validResetAt(resetsAt)
  if (at == null || at <= now) {
    return null
  }
  return formatResetDuration(at - now, (value, unit) =>
    intlLocale.startsWith('en')
      ? formatUiNarrowDuration(value, unit, intlLocale)
      : uiNumberFormat(RESET_UNIT_FORMATS[unit], intlLocale).format(value)
  )
}

/** "resets in 3h 35m" / "resets now"; null when the window reports no reset. */
export function formatResetsInCaption(
  resetsAt: number | null | undefined,
  now: number,
  intlLocale: string,
  t: Translate
): string | null {
  const at = validResetAt(resetsAt)
  if (at == null) {
    return null
  }
  const duration = formatLocalizedResetDuration(at, now, intlLocale)
  return duration === null
    ? t('auto.components.status.bar.InlineUsageBars.resetsNow', 'resets now')
    : t('auto.components.status.bar.InlineUsageBars.resetsIn', 'resets in {{duration}}', {
        duration
      })
}
