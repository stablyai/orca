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
