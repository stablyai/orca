import { translate } from '@/i18n/i18n'
import {
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'

export function formatUsagePercentageLabel(
  usedPercent: number,
  display: UsagePercentageDisplay,
  estimated = false
): string {
  const percentage = getDisplayedUsagePercentage(usedPercent, display)
  const value = `${estimated ? '≈' : ''}${percentage}`
  return display === 'used'
    ? translate('auto.components.status.bar.usagePercentageLabel.used', '{{value0}}% used', {
        value0: value
      })
    : translate('auto.components.status.bar.usagePercentageLabel.remaining', '{{value0}}% left', {
        value0: value
      })
}
