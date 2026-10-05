import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { DEFAULT_FILE_ICON_THEME } from '../../../../shared/file-icon-theme'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { getFileIconThemeEntries } from './file-icon-theme-search'

/** Keep the icon-theme control self-contained so the appearance section stays under its line budget. */
export function FileIconThemeSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const entry = getFileIconThemeEntries()[0]
  const label = translate(
    'auto.components.settings.AppearancePane.fileIconThemeLabel',
    'File Icons'
  )

  return (
    <SearchableSetting
      title={entry?.title}
      description={entry?.description}
      keywords={entry?.keywords ?? ['file icons', 'material', 'classic']}
    >
      <SettingsRow
        label={label}
        description={entry?.description}
        control={
          <SettingsSegmentedControl
            value={settings.fileIconTheme ?? DEFAULT_FILE_ICON_THEME}
            onChange={(fileIconTheme) => updateSettings({ fileIconTheme })}
            ariaLabel={label}
            options={[
              {
                value: 'classic',
                label: translate(
                  'auto.components.settings.AppearancePane.fileIconThemeClassic',
                  'Classic'
                )
              },
              {
                value: 'material',
                label: translate(
                  'auto.components.settings.AppearancePane.fileIconThemeMaterial',
                  'Material'
                )
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
