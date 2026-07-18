import type React from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { getFollowSymlinkedDirectoriesEntry } from './appearance-search'

type FollowSymlinkedDirectoriesSettingProps = {
  settings: Pick<GlobalSettings, 'followSymlinkedDirectories'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function FollowSymlinkedDirectoriesSetting({
  settings,
  updateSettings
}: FollowSymlinkedDirectoriesSettingProps): React.JSX.Element {
  const entry = getFollowSymlinkedDirectoriesEntry()
  const enabled = settings.followSymlinkedDirectories === true

  return (
    <SearchableSetting title={entry.title} description={entry.description} keywords={entry.keywords}>
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.AppearancePane.followSymlinkedDirectories.title',
          'Follow symlinked directories in file explorer'
        )}
        // Why: name the macOS permission-prompt tradeoff; the location (file
        // explorer) is obvious from the section header.
        description={translate(
          'auto.components.settings.AppearancePane.followSymlinkedDirectories.description',
          'Expand symlinked directories instead of showing them as files. May trigger a macOS permission prompt.'
        )}
        checked={enabled}
        onChange={() => updateSettings({ followSymlinkedDirectories: !enabled })}
      />
    </SearchableSetting>
  )
}
