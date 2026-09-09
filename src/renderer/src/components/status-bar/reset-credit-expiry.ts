import { formatResetDuration } from '../../../../shared/rate-limit-reset-format'
import { translate } from '@/i18n/i18n'

export function formatResetCreditExpiry(
  expiresAt: number | null | undefined,
  count: number
): string | null {
  if (!expiresAt) {
    return null
  }
  const duration = formatResetDuration(expiresAt - Date.now())
  if (duration === 'now') {
    return count > 1
      ? translate('components.resetCreditExpiry.nextNow', 'Next expires now')
      : translate('components.resetCreditExpiry.singleNow', 'Expires now')
  }
  return count > 1
    ? translate('components.resetCreditExpiry.nextIn', 'Next expires in {{duration}}', {
        duration
      })
    : translate('components.resetCreditExpiry.singleIn', 'Expires in {{duration}}', {
        duration
      })
}
