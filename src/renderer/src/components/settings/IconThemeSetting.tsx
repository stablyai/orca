import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { getIconThemeEntry } from './appearance-sidebar-search'

type IconThemeSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible?: boolean
}

export function IconThemeSetting({
  settings,
  updateSettings,
  forceVisible = false
}: IconThemeSettingProps): React.JSX.Element {
  const entry = getIconThemeEntry()
  return (
    <SearchableSetting
      title={entry.title}
      description={entry.description}
      keywords={entry.keywords}
      forceVisible={forceVisible}
    >
      <SettingsRow
        label={entry.title}
        description={entry.description}
        control={
          <SettingsSegmentedControl
            ariaLabel={entry.title}
            value={settings.iconTheme ?? 'default'}
            onChange={(iconTheme) => updateSettings({ iconTheme })}
            options={[
              {
                value: 'default',
                label: translate(
                  'auto.components.settings.AppearanceWindowSidebarSection.iconThemeDefault',
                  'Default'
                )
              },
              {
                value: 'vscode',
                label: translate(
                  'auto.components.settings.AppearanceWindowSidebarSection.iconThemeVscode',
                  'VS Code'
                )
              }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
