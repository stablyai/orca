import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import {
  normalizeFileExplorerSortMode,
  type FileExplorerSortMode
} from '../../../../../shared/file-listing/file-name-sort'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'
import { getFileExplorerSortModeEntry } from './appearance-file-explorer-sort-search'

export function FileExplorerSortModeSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const entry = getFileExplorerSortModeEntry(t)
  const value = normalizeFileExplorerSortMode(settings.fileExplorerSortMode)

  return (
    <SearchableSetting {...entry}>
      <SettingsRow
        label={entry.title}
        description={entry.description}
        control={
          <SettingsSegmentedControl<FileExplorerSortMode>
            value={value}
            onChange={(fileExplorerSortMode) => updateSettings({ fileExplorerSortMode })}
            ariaLabel={entry.title}
            size="sm"
            options={[
              {
                value: 'folders-first',
                label: t('settings.fileExplorerSortMode.foldersFirst', 'Folders first')
              },
              {
                value: 'files-first',
                label: t('settings.fileExplorerSortMode.filesFirst', 'Files first')
              },
              { value: 'mixed', label: t('settings.fileExplorerSortMode.mixed', 'Mixed') }
            ]}
          />
        }
      />
    </SearchableSetting>
  )
}
