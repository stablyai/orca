import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { UsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import { getProviderDisplayName } from '../../../../../shared/agent-usage/display/usage-provider-windows'
import type { Translate } from '@/i18n/use-translate'
import { getStatusBarUsageSections } from '../composition/status-bar-usage-sections'
import { formatUsagePercentageLabel } from './usage-percentage-label'

/** What a compact chip stands for, named in full: "Claude Fable 96% used", "Cursor Models 64% used". */
export function formatUsageChipTitle(
  p: ProviderRateLimits,
  display: UsagePercentageDisplay,
  t: Translate
): string {
  const providerName = getProviderDisplayName(p.provider)
  const headline = getStatusBarUsageSections(p, 'compact', t)[0]
  if (!headline) {
    return providerName
  }
  const name = headline.label
  const subject =
    !name || name.startsWith(providerName) ? name || providerName : `${providerName} ${name}`
  return `${subject} ${formatUsagePercentageLabel(headline.window.usedPercent, display, t)}`
}
