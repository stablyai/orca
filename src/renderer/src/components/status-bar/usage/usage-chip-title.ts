import type { UsageRosterProvider } from './plugin-usage-roster-provider'
import type { UsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import { usageRosterProviderName } from './plugin-usage-roster-provider'
import type { Translate } from '@/i18n/use-translate'
import { getStatusBarUsageSections } from '../composition/status-bar-usage-sections'
import { formatUsagePercentageLabel } from './usage-percentage-label'

/** What a compact chip stands for, named in full: "Claude Fable 96% used", "Cursor Models 64% used". */
export function formatUsageChipTitle(
  p: UsageRosterProvider,
  display: UsagePercentageDisplay,
  t: Translate
): string {
  const providerName = usageRosterProviderName(p, t)
  const headline = getStatusBarUsageSections(p, 'compact', t)[0]
  if (!headline) {
    return providerName
  }
  const name = headline.label
  const subject =
    !name || name.startsWith(providerName) ? name || providerName : `${providerName} ${name}`
  return `${subject} ${formatUsagePercentageLabel(headline.window.usedPercent, display, t)}`
}
