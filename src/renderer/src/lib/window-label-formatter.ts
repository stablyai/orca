import { formatResetDuration } from '../../../shared/rate-limit-reset-format'
import { getIntlLocale } from '@/i18n/i18n'

/** Format usage-window duration; retain 10080 minutes → wk compatibility with the original status bar. */
export function formatWindowLabel(windowMinutes: number): string {
  const locale = getIntlLocale()
  if (locale.startsWith('ru')) {
    const duration = (
      [
        [10080, 'week'],
        [1440, 'day'],
        [60, 'hour']
      ] as const
    ).find(([minutes]) => windowMinutes >= minutes && windowMinutes % minutes === 0)
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: duration?.[1] ?? 'minute',
      unitDisplay: 'short'
    }).format(duration ? windowMinutes / duration[0] : windowMinutes)
  }
  if (windowMinutes === 10080) {
    return 'wk'
  }
  if (windowMinutes === 300) {
    return '5h'
  }
  if (windowMinutes === 60) {
    return '1h'
  }
  if (windowMinutes < 60) {
    return `${windowMinutes}m`
  }
  if (windowMinutes % (60 * 24 * 7) === 0) {
    return `${windowMinutes / (60 * 24 * 7)}wk`
  }
  if (windowMinutes % (60 * 24) === 0) {
    return `${windowMinutes / (60 * 24)}d`
  }
  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h`
  }
  return `${windowMinutes}m`
}

/** Match popup remaining-time labels when resetsAt exists (#8378); otherwise use fixed window duration. */
export function formatRateLimitWindowChipLabel(
  window: { windowMinutes: number; resetsAt: number | null },
  now: number = Date.now()
): string {
  if (window.resetsAt != null) {
    return formatResetDuration(window.resetsAt - now)
  }
  return formatWindowLabel(window.windowMinutes)
}
