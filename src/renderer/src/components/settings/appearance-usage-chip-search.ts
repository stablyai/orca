import { translate } from '@/i18n/i18n'
import {
  formatUsagePercentageLabel,
  formatUsagePercentageValue
} from '../status-bar/usage-percentage-label'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import {
  STATUS_BAR_USAGE_CHIP_PRESETS,
  type StatusBarUsageChipParts,
  type StatusBarUsageChipPreset
} from '../../../../shared/status-bar-usage-chip-format'
import { translateSearchKeyword } from './settings-search-keywords'

export const USAGE_CHIP_FORMAT_SETTING_ID = 'appearance-usage-chip-format'

/**
 * The reading the preview is built from, as a used-percentage.
 *
 * Fixed rather than taken from a live provider so the preview reads the same on
 * a fresh install with no usage data, and so every option is compared against
 * the same numbers.
 */
const CHIP_SAMPLE_USED_PERCENT = 42

/**
 * Sample values the settings preview renders, for the display mode in force.
 *
 * Why it takes the mode instead of hardcoding "used": in 'remaining' mode the
 * status bar draws the complement and the word "left", so a fixed sample made
 * the preview promise "42% used" next to a bar reading "58% left". Both strings
 * come from the helpers the status bar itself uses.
 */
export function getChipSample(display: UsagePercentageDisplay): {
  percentage: string
  labelled: string
  spacedDuration: string
  tightDuration: string
} {
  return {
    percentage: formatUsagePercentageValue(CHIP_SAMPLE_USED_PERCENT, display),
    labelled: formatUsagePercentageLabel(CHIP_SAMPLE_USED_PERCENT, display),
    spacedDuration: '3h 54m',
    tightDuration: '3h54m'
  }
}

export function getUsageChipFormatEntry(): {
  id: string
  title: string
  description: string
  keywords: string[]
} {
  return {
    id: USAGE_CHIP_FORMAT_SETTING_ID,
    title: translate(
      'auto.components.settings.appearance.search.usageChipFormatTitle',
      'Usage chip format'
    ),
    description: translate(
      'auto.components.settings.appearance.search.usageChipFormatDescription',
      'Choose how much each usage meter spells out in the status bar.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.usageChipFormatKeyword',
        'usage chip'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.usageChipCompactKeyword',
        'compact'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.appearance.search.usageChipStatusBarKeyword',
        'status bar'
      )
    ]
  }
}

/**
 * Why a function and not a const array: `translate()` must not run at module
 * load time — i18n is not initialised yet, and the locale can change later.
 * The i18n import-time safety test enforces this.
 */
export function getChipPresetOptions(): {
  value: StatusBarUsageChipPreset
  label: string
}[] {
  return [
    {
      value: 'labelled',
      label: translate('auto.components.settings.appearance.chipPresetLabelled', 'Labelled')
    },
    {
      value: 'compact',
      label: translate('auto.components.settings.appearance.chipPresetCompact', 'Compact')
    },
    {
      value: 'percentOnly',
      label: translate('auto.components.settings.appearance.chipPresetPercentOnly', 'Percent')
    }
  ]
}

/**
 * The individual parts, offered as switches beneath the presets so a user can
 * land on a combination the presets do not cover.
 */
export const CHIP_PART_TOGGLES: {
  key: keyof StatusBarUsageChipParts
  label: () => string
  description: () => string
}[] = [
  {
    key: 'statusBarUsageChipDisplayWord',
    label: () =>
      translate('auto.components.settings.appearance.chipPartDisplayWord', 'Show "used" / "left"'),
    description: () =>
      translate(
        'auto.components.settings.appearance.chipPartDisplayWordDescription',
        'Spell the direction out on every meter instead of leaving it to the tooltip.'
      )
  },
  {
    key: 'statusBarUsageChipTightDuration',
    label: () =>
      translate('auto.components.settings.appearance.chipPartTightDuration', 'Tight durations'),
    description: () =>
      translate(
        'auto.components.settings.appearance.chipPartTightDurationDescription',
        'Drop the space inside a countdown: "3h54m" rather than "3h 54m".'
      )
  },
  {
    key: 'statusBarUsageChipWindowLabel',
    label: () =>
      translate('auto.components.settings.appearance.chipPartWindowLabel', 'Show countdown'),
    description: () =>
      translate(
        'auto.components.settings.appearance.chipPartWindowLabelDescription',
        'Show time until the window resets next to the percentage.'
      )
  }
]

export { STATUS_BAR_USAGE_CHIP_PRESETS }
