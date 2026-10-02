import type { RateLimitWindow } from '../../../../shared/rate-limit-types'
import {
  formatResetCountdown,
  formatResetDuration
} from '../../../../shared/rate-limit-reset-format'
import { translate } from '@/i18n/i18n'

export function getUsageWindowReplenishmentTime(window: RateLimitWindow): number | null {
  return window.rechargesAt ?? window.refillsAt ?? window.resetsAt ?? null
}

export function getUsageWindowReplenishmentLabel(
  window: RateLimitWindow,
  now: number
): string | null {
  const time = getUsageWindowReplenishmentTime(window)
  if (time === null) {
    return null
  }
  if (window.rechargesAt != null) {
    const duration = formatResetDuration(time - now)
    return duration === 'now'
      ? translate('settings.synthetic.rechargeNow', 'Full recharge now')
      : translate('settings.synthetic.rechargeCountdown', 'Full recharge in {{duration}}', {
          duration
        })
  }
  if (window.refillsAt != null) {
    const duration = formatResetDuration(time - now)
    return duration === 'now'
      ? translate('settings.synthetic.refillNow', 'Next refill now')
      : translate('settings.synthetic.refillCountdown', 'Next refill in {{duration}}', { duration })
  }
  return formatResetCountdown(time - now)
}
