import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import {
  getShowPinnedWorktreesInGroupsEntry,
  getShowWorktreeUncommittedChangesEntry
} from './appearance-sidebar-search'

type WorktreeListToggleSettingsProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function WorktreeListToggleSettings({
  settings,
  updateSettings
}: WorktreeListToggleSettingsProps): React.JSX.Element {
  const t = useTranslate()
  const uncommittedChanges = getShowWorktreeUncommittedChangesEntry()
  const showUncommittedChanges = settings.showWorktreeUncommittedChanges !== false
  return (
    <>
      <SearchableSetting
        title={getShowPinnedWorktreesInGroupsEntry().title}
        description={getShowPinnedWorktreesInGroupsEntry().description}
        keywords={getShowPinnedWorktreesInGroupsEntry().keywords}
      >
        <SettingsSwitchRow
          label={t(
            'auto.components.settings.AppearancePane.showPinnedWorktreesInGroups.title',
            'Also show pinned worktrees in their original lists'
          )}
          // This opt-in duplicates pinned worktrees into natural groups while preserving Pinned.
          description={t(
            'auto.components.settings.AppearancePane.showPinnedWorktreesInGroups.description',
            'Pinned worktrees stay in Pinned and also appear in All, Project, Status, and PR.'
          )}
          checked={settings.showPinnedWorktreesInGroups === true}
          onChange={() =>
            updateSettings({
              showPinnedWorktreesInGroups: !(settings.showPinnedWorktreesInGroups === true)
            })
          }
        />
      </SearchableSetting>

      <SearchableSetting
        title={uncommittedChanges.title}
        description={uncommittedChanges.description}
        keywords={uncommittedChanges.keywords}
      >
        <SettingsSwitchRow
          label={uncommittedChanges.title}
          description={uncommittedChanges.description}
          checked={showUncommittedChanges}
          onChange={() =>
            updateSettings({ showWorktreeUncommittedChanges: !showUncommittedChanges })
          }
        />
      </SearchableSetting>
    </>
  )
}
