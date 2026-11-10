import type { UsageFailure } from '../../store/slices/usage/usage-provider-types'
import type { Translate } from '@/i18n/use-translate'

export function usageFailureMessage(failure: UsageFailure | null, t: Translate): string | null {
  if (failure?.terminal) {
    return t('usage.failure.unavailable', 'Usage is unavailable. Try Refresh to reconnect.')
  }
  if (failure?.setting) {
    return t(
      'usage.failure.setting',
      'The tracking change could not be confirmed. Try changing it again.'
    )
  }
  if (failure?.refresh) {
    return t(
      'usage.failure.refresh',
      'The previous Refresh could not be completed. Try Refresh again.'
    )
  }
  if (failure?.read) {
    return t('usage.failure.read', 'Usage could not be loaded. Try Refresh again.')
  }
  return null
}
