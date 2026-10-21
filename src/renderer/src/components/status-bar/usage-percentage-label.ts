import { translate } from '@/i18n/i18n'
import {
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'

export function formatUsagePercentageLabel(
  usedPercent: number,
  display: UsagePercentageDisplay
): string {
  const percentage = getDisplayedUsagePercentage(usedPercent, display)
  return display === 'used'
    ? translate('auto.components.status.bar.usagePercentageLabel.used', '{{value0}}% used', {
        value0: String(percentage)
      })
    : translate('auto.components.status.bar.usagePercentageLabel.remaining', '{{value0}}% left', {
        value0: String(percentage)
      })
}

/** Percentage without the used/left word, for rows that state the unit once. */
export function formatBareUsagePercentage(
  usedPercent: number,
  display: UsagePercentageDisplay
): string {
  return translate('auto.components.status.bar.usagePercentageLabel.bare', '{{value0}}%', {
    value0: String(getDisplayedUsagePercentage(usedPercent, display))
  })
}
