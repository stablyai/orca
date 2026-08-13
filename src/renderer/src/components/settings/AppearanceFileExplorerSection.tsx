import type React from 'react'

import type { GlobalSettings } from '../../../../shared/types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { getLayoutEntries } from './appearance-search'
import { translate } from '@/i18n/i18n'

type AppearanceFileExplorerSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function AppearanceFileExplorerSection({
  settings,
  updateSettings
}: AppearanceFileExplorerSectionProps): React.JSX.Element {
  const [gitIgnoredEntry, renameOnDoubleClickEntry] = getLayoutEntries()
  const showGitIgnoredFiles = settings.showGitIgnoredFiles ?? true
  const renameOnDoubleClick = settings.fileExplorerRenameOnDoubleClick ?? true

  return (
    <div className="space-y-3">
      <SettingsSubsectionHeader
        title={translate('auto.components.settings.AppearancePane.d496901cd0', 'File Explorer')}
      />
      <div className="ml-4 divide-y divide-border/40">
        <SearchableSetting
          title={
            gitIgnoredEntry?.title ??
            translate(
              'auto.components.settings.AppearancePane.0fafabcf35',
              'Show Git-Ignored Files'
            )
          }
          description={gitIgnoredEntry?.description}
          keywords={gitIgnoredEntry?.keywords ?? ['git', 'gitignore', 'ignored']}
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.AppearancePane.0fafabcf35',
              'Show Git-Ignored Files'
            )}
            // Why: define what "git-ignored" matches; the location (file explorer)
            // is obvious from the section header.
            description={translate(
              'auto.components.settings.AppearancePane.gitIgnoredGlossary',
              'Files matched by .gitignore.'
            )}
            checked={showGitIgnoredFiles}
            onChange={() => updateSettings({ showGitIgnoredFiles: !showGitIgnoredFiles })}
          />
        </SearchableSetting>

        <SearchableSetting
          title={
            renameOnDoubleClickEntry?.title ??
            translate(
              'auto.components.settings.AppearancePane.fileExplorerRenameOnDoubleClick.title',
              'Rename on Double-Click'
            )
          }
          description={renameOnDoubleClickEntry?.description}
          keywords={renameOnDoubleClickEntry?.keywords ?? ['rename', 'double click']}
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.AppearancePane.fileExplorerRenameOnDoubleClick.title',
              'Rename on Double-Click'
            )}
            // Why: name the cost, not the mechanism — the delay is why anyone
            // turns this off, and the surviving rename paths are what makes it safe to.
            description={translate(
              'auto.components.settings.AppearancePane.fileExplorerRenameOnDoubleClick.description',
              'Off makes folders expand and collapse instantly. Rename stays available with Enter and the right-click menu.'
            )}
            checked={renameOnDoubleClick}
            onChange={() =>
              updateSettings({ fileExplorerRenameOnDoubleClick: !renameOnDoubleClick })
            }
          />
        </SearchableSetting>
      </div>
    </div>
  )
}
