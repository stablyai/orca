import React from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  normalizeTabSizing,
  normalizeTabSizingMode,
  TAB_SIZING_MODES,
  DEFAULT_TAB_MAX_WIDTH,
  DEFAULT_TAB_MIN_WIDTH,
  TAB_WIDTH_LOWER_BOUND,
  TAB_WIDTH_UPPER_BOUND,
  type TabSizingMode
} from '../../../../../shared/tab-sizing'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { NumberField, SettingsRow } from '../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'

type TabSizingSettingsUpdate = Partial<
  Pick<GlobalSettings, 'tabSizing' | 'tabSizingMinWidth' | 'tabSizingMaxWidth'>
>

export function TabSizingSettings({
  settings,
  updateSettings
}: {
  settings: Pick<GlobalSettings, 'tabSizing' | 'tabSizingMinWidth' | 'tabSizingMaxWidth'>
  updateSettings: (updates: TabSizingSettingsUpdate) => Promise<void> | void
}): React.JSX.Element {
  const t = useTranslate()
  const tabSizing = normalizeTabSizing(settings)
  const usesMaxWidth = tabSizing.mode === 'auto' || tabSizing.mode === 'fixed'
  const modeLabels: Record<TabSizingMode, string> = {
    auto: t('auto.components.settings.TabSizingSettings.mode_auto', 'Auto'),
    fit: t('auto.components.settings.TabSizingSettings.mode_fit', 'Fit'),
    shrink: t('auto.components.settings.TabSizingSettings.mode_shrink', 'Shrink'),
    fixed: t('auto.components.settings.TabSizingSettings.mode_fixed', 'Fixed')
  }
  const modeDescriptions: Record<TabSizingMode, string> = {
    auto: t(
      'auto.components.settings.TabSizingSettings.mode_auto_description',
      'Terminal and chat tabs keep the max width; file and browser tabs fit their titles up to it.'
    ),
    fit: t(
      'auto.components.settings.TabSizingSettings.mode_fit_description',
      'Always keep tabs large enough to show the full title. The tab bar scrolls when they do not fit.'
    ),
    shrink: t(
      'auto.components.settings.TabSizingSettings.mode_shrink_description',
      'Tabs fit their titles and get smaller, down to the min width, when space runs out.'
    ),
    fixed: t(
      'auto.components.settings.TabSizingSettings.mode_fixed_description',
      'Make all tabs the same size, between the min and max width.'
    )
  }
  const minWidthLabel = t('auto.components.settings.TabSizingSettings.min_width', 'Tab Min Width')
  const maxWidthLabel = t('auto.components.settings.TabSizingSettings.max_width', 'Tab Max Width')
  const keywords = ['tab', 'width', 'size', 'sizing', 'fit', 'shrink', 'fixed', 'compact', 'narrow']

  return (
    <>
      <SearchableSetting
        title={t('auto.components.settings.TabSizingSettings.title', 'Tab Sizing')}
        description={modeDescriptions[tabSizing.mode]}
        keywords={keywords}
        className="max-w-none"
      >
        <SettingsRow
          label={t('auto.components.settings.TabSizingSettings.title', 'Tab Sizing')}
          description={modeDescriptions[tabSizing.mode]}
          control={
            <Select
              value={tabSizing.mode}
              onValueChange={(value) =>
                void updateSettings({ tabSizing: normalizeTabSizingMode(value) })
              }
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TAB_SIZING_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {modeLabels[mode]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </SearchableSetting>
      <SearchableSetting
        title={minWidthLabel}
        description={t(
          'auto.components.settings.TabSizingSettings.min_width_description',
          'Tabs never get narrower than this; the tab bar scrolls instead.'
        )}
        keywords={keywords}
      >
        <NumberField
          label={minWidthLabel}
          description={t(
            'auto.components.settings.TabSizingSettings.min_width_description',
            'Tabs never get narrower than this; the tab bar scrolls instead.'
          )}
          value={tabSizing.minWidth}
          defaultValue={DEFAULT_TAB_MIN_WIDTH}
          min={TAB_WIDTH_LOWER_BOUND}
          max={TAB_WIDTH_UPPER_BOUND}
          integer
          suffix="px"
          onChange={(value) =>
            void updateSettings({
              tabSizingMinWidth: value,
              ...(value > tabSizing.maxWidth ? { tabSizingMaxWidth: value } : {})
            })
          }
        />
      </SearchableSetting>
      <SearchableSetting
        title={maxWidthLabel}
        description={t(
          'auto.components.settings.TabSizingSettings.max_width_description',
          'Tabs never get wider than this.'
        )}
        keywords={keywords}
      >
        <NumberField
          label={maxWidthLabel}
          description={t(
            'auto.components.settings.TabSizingSettings.max_width_description',
            'Tabs never get wider than this.'
          )}
          value={tabSizing.maxWidth}
          defaultValue={DEFAULT_TAB_MAX_WIDTH}
          min={TAB_WIDTH_LOWER_BOUND}
          max={TAB_WIDTH_UPPER_BOUND}
          integer
          suffix="px"
          disabled={!usesMaxWidth}
          disabledReason={t(
            'auto.components.settings.TabSizingSettings.max_width_disabled',
            'Only used when Tab Sizing is Auto or Fixed.'
          )}
          onChange={(value) =>
            void updateSettings({
              tabSizingMaxWidth: value,
              ...(value < tabSizing.minWidth ? { tabSizingMinWidth: value } : {})
            })
          }
        />
      </SearchableSetting>
    </>
  )
}
