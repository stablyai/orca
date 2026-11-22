import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroupSubsection } from '../section-layout/SettingsGroup'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import type { SettingsSearchEntry } from '../search/settings-search'
import { getFollowSymlinkedDirectoriesEntry } from './appearance-search'
import { getExplorerRevealActiveFileEntry } from './appearance-file-explorer-search'

type AppearanceFileExplorerSubsectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  showGitIgnoredEntry?: SettingsSearchEntry
}

export function AppearanceFileExplorerSubsection({
  settings,
  updateSettings,
  showGitIgnoredEntry
}: AppearanceFileExplorerSubsectionProps): React.JSX.Element {
  const t = useTranslate()
  const followSymlinkEntry = getFollowSymlinkedDirectoriesEntry(t)
  const revealActiveFileEntry = getExplorerRevealActiveFileEntry(t)
  const revealActiveFileEnabled = settings.explorerRevealActiveFile !== false

  return (
    <SettingsGroupSubsection
      title={t('auto.components.settings.AppearancePane.8e374ce9a3', 'File explorer')}
    >
      <SearchableSetting
        title={
          showGitIgnoredEntry?.title ??
          t('auto.components.settings.AppearancePane.7e958ee950', 'Show Git-ignored files')
        }
        description={showGitIgnoredEntry?.description}
        keywords={showGitIgnoredEntry?.keywords ?? ['git', 'gitignore', 'ignored']}
      >
        <SettingsSwitchRow
          label={t('auto.components.settings.AppearancePane.7e958ee950', 'Show Git-ignored files')}
          description={t(
            'auto.components.settings.AppearancePane.gitIgnoredGlossary',
            'Files matched by .gitignore.'
          )}
          checked={settings.showGitIgnoredFiles ?? true}
          onChange={() =>
            updateSettings({
              showGitIgnoredFiles: !(settings.showGitIgnoredFiles ?? true)
            })
          }
        />
      </SearchableSetting>
      <SearchableSetting {...followSymlinkEntry}>
        <SettingsSwitchRow
          label={followSymlinkEntry.title}
          description={followSymlinkEntry.description}
          checked={settings.followSymlinkedDirectories ?? false}
          onChange={() =>
            updateSettings({
              followSymlinkedDirectories: !settings.followSymlinkedDirectories
            })
          }
        />
      </SearchableSetting>
      <SearchableSetting {...revealActiveFileEntry}>
        <SettingsSwitchRow
          label={revealActiveFileEntry.title}
          description={revealActiveFileEntry.description}
          checked={revealActiveFileEnabled}
          onChange={() =>
            updateSettings({
              explorerRevealActiveFile: !revealActiveFileEnabled
            })
          }
        />
      </SearchableSetting>
    </SettingsGroupSubsection>
  )
}
