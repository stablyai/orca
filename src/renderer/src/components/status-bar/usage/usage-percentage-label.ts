import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { UsageSection } from './usage-headline-sections'
import {
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../../shared/agent-usage/display/usage-percentage-display'

/** MCP windows are not weekly, so they get no weekly-limit title. */
export function formatScopedUsageTitle(
  p: ProviderRateLimits,
  section: UsageSection,
  display: UsagePercentageDisplay,
  t: Translate
): string | undefined {
  if (section.window !== p.fableWeekly) {
    return undefined
  }
  return t(
    'auto.components.status.bar.UsageRosterPanel.modelWeeklyLimit',
    '{{model}} weekly limit: {{usage}}',
    {
      model: section.label,
      usage: formatUsagePercentageLabel(section.window.usedPercent, display, t)
    }
  )
}

export function formatUsagePercentageLabel(
  usedPercent: number,
  display: UsagePercentageDisplay,
  t: Translate = translate
): string {
  const percentage = getDisplayedUsagePercentage(usedPercent, display)
  return display === 'used'
    ? t('auto.components.status.bar.usagePercentageLabel.used', '{{value0}}% used', {
        value0: String(percentage)
      })
    : t('auto.components.status.bar.usagePercentageLabel.remaining', '{{value0}}% left', {
        value0: String(percentage)
      })
}

export function formatBareUsagePercentage(
  usedPercent: number,
  display: UsagePercentageDisplay,
  t: Translate = translate
): string {
  return t('auto.components.status.bar.usagePercentageLabel.bare', '{{value0}}%', {
    value0: String(getDisplayedUsagePercentage(usedPercent, display))
  })
}
