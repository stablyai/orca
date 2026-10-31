import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
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
          label={translate(
            'auto.components.settings.AppearancePane.showPinnedWorktreesInGroups.title',
            'Also show pinned worktrees in their original lists'
          )}
          // This opt-in duplicates pinned worktrees into natural groups while preserving Pinned.
          description={translate(
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
