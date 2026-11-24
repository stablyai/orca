import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import {
  normalizeTabMaxWidth,
  normalizeTabWidthMode,
  TAB_MAX_WIDTH_DEFAULT_PX,
  TAB_MAX_WIDTH_MAX_PX,
  TAB_MAX_WIDTH_MIN_PX,
  type TabWidthMode
} from '../../../../../shared/workspace-layout/tab-groups/tab-width-settings'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import {
  NumberField,
  SettingsRow,
  SettingsSegmentedControl
} from '../form-controls/SettingsFormControls'

export function TabWidthSettings({
  settings,
  updateSettings
}: {
  settings: Pick<GlobalSettings, 'tabWidthMode' | 'tabMaxWidth'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const tabWidthMode = normalizeTabWidthMode(settings.tabWidthMode)
  const tabMaxWidth = normalizeTabMaxWidth(settings.tabMaxWidth)
  const widthTitle = t('settings.general.tabWidth.title', 'Tab width')
  const widthDescription = t(
    'settings.general.tabWidth.description',
    'Fit sizes every tab to its title and scrolls on overflow.'
  )
  const maxWidthTitle = t('settings.general.tabMaxWidth.title', 'Max tab width')
  const maxWidthDescription = t(
    'settings.general.tabMaxWidth.description',
    'Caps tab width for long titles and inline rename.'
  )

  return (
    <>
      <SearchableSetting
        title={widthTitle}
        description={widthDescription}
        keywords={['tab', 'tabs', 'width', 'fit', 'compact', 'narrow', 'sizing', 'scroll']}
      >
        <SettingsRow
          label={widthTitle}
          description={widthDescription}
          control={
            <SettingsSegmentedControl<TabWidthMode>
              ariaLabel={widthTitle}
              value={tabWidthMode}
              onChange={(mode) => updateSettings({ tabWidthMode: mode })}
              options={[
                {
                  value: 'default',
                  label: t('settings.general.tabWidth.default', 'Default')
                },
                {
                  value: 'fit',
                  label: t('settings.general.tabWidth.fit', 'Fit')
                }
              ]}
            />
          }
        />
      </SearchableSetting>
      <SearchableSetting
        title={maxWidthTitle}
        description={maxWidthDescription}
        keywords={['tab', 'tabs', 'max', 'width', 'compact', 'narrow', 'truncate', 'px']}
      >
        <NumberField
          label={maxWidthTitle}
          description={maxWidthDescription}
          value={tabMaxWidth}
          defaultValue={TAB_MAX_WIDTH_DEFAULT_PX}
          min={TAB_MAX_WIDTH_MIN_PX}
          max={TAB_MAX_WIDTH_MAX_PX}
          step={10}
          integer
          suffix={t('auto.components.settings.editorTypography.fontSizeUnit', 'px')}
          onChange={(next) => updateSettings({ tabMaxWidth: next })}
        />
      </SearchableSetting>
    </>
  )
}
