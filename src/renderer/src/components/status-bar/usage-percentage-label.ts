import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import {
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'

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
