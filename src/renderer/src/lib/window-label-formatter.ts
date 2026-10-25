import { formatResetDuration } from '../../../shared/rate-limit-reset-format'
import { getIntlLocale } from '@/i18n/i18n'

/**
 * Returns a short human-readable label for a usage window duration.
 *
 * Why: 10080 minutes (7 days) is hard-coded as "wk" for backward
 * compatibility with the original StatusBar implementation.
 */
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

/**
 * Status-bar chip label for a rate-limit window.
 *
 * Why: the popup already shows remaining time via formatResetCountdown
 * ("Resets in 2h 33m"). The chip used fixed windowMinutes labels ("5h"),
 * so the same Codex session looked out of sync (#8378). Prefer remaining
 * duration when resetsAt is known; fall back to the fixed window size only
 * when no reset timestamp is available.
 */
export function formatRateLimitWindowChipLabel(
  window: { windowMinutes: number; resetsAt: number | null },
  now: number = Date.now()
): string {
  if (window.resetsAt != null) {
    return formatResetDuration(window.resetsAt - now)
  }
  return formatWindowLabel(window.windowMinutes)
}
