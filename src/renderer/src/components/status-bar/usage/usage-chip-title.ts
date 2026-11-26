import type { UsageRosterProvider } from './plugin-usage-roster-provider'
import type { UsagePercentageDisplay } from '../../../../../shared/agent-usage/display/usage-percentage-display'
import { isPluginUsageProvider, usageRosterProviderName } from './plugin-usage-roster-provider'
import type { Translate } from '@/i18n/use-translate'
import type { StatusBarUsageSection } from '../composition/status-bar-usage-sections'
import { formatUsagePercentageLabel } from './usage-percentage-label'

/**
 * What a compact chip stands for, named in full: "Claude Fable 96% used", "Cursor Models 64% used".
 * Why the caller passes the headline: chips already derived it, so the title must not re-derive it.
 */
export function formatUsageChipTitle(
  p: UsageRosterProvider,
  headline: StatusBarUsageSection | undefined,
  display: UsagePercentageDisplay,
  t: Translate
): string {
  const providerName = usageRosterProviderName(p, t)
  if (!headline) {
    return providerName
  }
  const name = isPluginUsageProvider(p)
    ? p.windows.find((window) => window === headline.window)?.rosterLabel
    : headline.label
  const subject =
    !name || name.startsWith(providerName) ? name || providerName : `${providerName} ${name}`
  return `${subject} ${formatUsagePercentageLabel(headline.window.usedPercent, display, t)}`
}
