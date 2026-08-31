import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { translate } from '@/i18n/i18n'
import { getProviderDisplayName, getProviderUsageStatusLabel } from './usage-error-copy'

export function getUsageRosterTriggerAriaLabel(providers: ProviderRateLimits[]): string {
  const title = translate('auto.components.status.bar.UsageRosterPanel.title', 'Usage')
  const failures = providers
    .filter((provider) => provider.status === 'error')
    .map(
      (provider) =>
        `${getProviderDisplayName(provider.provider)}: ${getProviderUsageStatusLabel(provider)}`
    )
  return failures.length > 0 ? `${title}. ${failures.join('. ')}` : title
}
