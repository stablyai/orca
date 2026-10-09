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
  // Why: bar fill and urgency color give consumption context, so bare % is shown in both modes.
  return translate(
    display === 'used'
      ? 'auto.components.status.bar.usagePercentageLabel.used'
      : 'auto.components.status.bar.usagePercentageLabel.remaining',
    '{{value0}}%',
    {
      value0: String(percentage)
    }
  )
}
