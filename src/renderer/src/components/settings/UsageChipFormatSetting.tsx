import type React from 'react'
import { useAppStore } from '../../store'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl, SettingsSwitchRow } from './SettingsFormControls'
import {
  CHIP_PART_TOGGLES,
  getChipSample,
  getChipPresetOptions,
  getUsageChipFormatEntry,
  STATUS_BAR_USAGE_CHIP_PRESETS
} from './appearance-usage-chip-search'
import {
  formatStatusBarUsageChipSample,
  matchStatusBarUsageChipPreset,
  type StatusBarUsageChipPreset
} from '../../../../shared/status-bar-usage-chip-format'
import { translate } from '@/i18n/i18n'

/**
 * Status-bar usage chip controls: the presets, a live sample, and a switch per
 * part so a user can land on a combination the presets do not cover.
 *
 * Its own component because the parts are read from the store individually and
 * the parent status-bar section is already at its line budget.
 */
export function UsageChipFormatSetting(): React.JSX.Element {
  const chipParts = {
    statusBarUsageChipDisplayWord: useAppStore((state) => state.statusBarUsageChipDisplayWord),
    statusBarUsageChipTightDuration: useAppStore((state) => state.statusBarUsageChipTightDuration),
    statusBarUsageChipWindowLabel: useAppStore((state) => state.statusBarUsageChipWindowLabel)
  }
  const setStatusBarUsageChipParts = useAppStore((state) => state.setStatusBarUsageChipParts)
  const usagePercentageDisplay = useAppStore((state) => state.usagePercentageDisplay)
  const activePreset = matchStatusBarUsageChipPreset(chipParts)
  const chipSample = formatStatusBarUsageChipSample(
    chipParts,
    getChipSample(usagePercentageDisplay)
  )
  const chipFormatEntry = getUsageChipFormatEntry()

  return (
    <SearchableSetting
      title={chipFormatEntry.title}
      description={chipFormatEntry.description}
      keywords={chipFormatEntry.keywords}
    >
      <div className="space-y-3">
        <SettingsRow
          label={chipFormatEntry.title}
          description={chipFormatEntry.description}
          control={
            /* Why 'custom' rather than falling back to a preset: the control
               marks an option active on an exact value match, so a value
               matching no option leaves every preset unhighlighted — the
               honest rendering of a combination the presets do not cover. */
            <SettingsSegmentedControl<StatusBarUsageChipPreset | 'custom'>
              value={activePreset ?? 'custom'}
              onChange={(preset) => {
                if (preset === 'custom') {
                  return
                }
                setStatusBarUsageChipParts(STATUS_BAR_USAGE_CHIP_PRESETS[preset])
              }}
              ariaLabel={chipFormatEntry.title}
              size="sm"
              options={getChipPresetOptions()}
            />
          }
        />
        {/* Why a live sample rather than static help text: the parts
              combine, so the only honest description of the current
              choice is the string the status bar will actually draw. */}
        <SettingsRow
          label={translate(
            'auto.components.settings.AppearanceWindowSidebarSection.chipPreviewLabel',
            'Preview'
          )}
          description={
            activePreset
              ? undefined
              : translate(
                  'auto.components.settings.AppearanceWindowSidebarSection.chipCustom',
                  'Custom combination'
                )
          }
          control={
            <span className="whitespace-nowrap tabular-nums text-xs text-muted-foreground">
              {chipSample}
            </span>
          }
        />
        {CHIP_PART_TOGGLES.map((part) => (
          <SettingsSwitchRow
            key={part.key}
            label={part.label()}
            description={part.description()}
            checked={chipParts[part.key]}
            onChange={() => setStatusBarUsageChipParts({ [part.key]: !chipParts[part.key] })}
            ariaLabel={part.label()}
          />
        ))}
      </div>
    </SearchableSetting>
  )
}
