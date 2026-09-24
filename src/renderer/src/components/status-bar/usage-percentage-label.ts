import { translate } from '@/i18n/i18n'
import {
  getDisplayedUsagePercentage,
  type UsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'

/**
 * The spelled-out reading for a window: "42% used" or "58% left".
 *
 * The number follows the mode — 'remaining' shows the complement — so the word
 * and the value are chosen together and callers must not recombine them.
 */
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

/**
 * Bare percentage for the status-bar chip: "42%", no "used"/"left" word.
 *
 * Why a chip may drop the word: it repeats a percentage per window and a
 * provider can show three, so the word costs four columns every time while
 * saying what the whole bar already says. Only the compact and percent-only
 * formats take that trade; the hover tooltip still spells it out (see
 * ProviderTooltip) and the popover names the display mode, so which end of the
 * scale this is stays discoverable.
 */
export function formatUsagePercentageValue(
  usedPercent: number,
  display: UsagePercentageDisplay
): string {
  return `${getDisplayedUsagePercentage(usedPercent, display)}%`
}
