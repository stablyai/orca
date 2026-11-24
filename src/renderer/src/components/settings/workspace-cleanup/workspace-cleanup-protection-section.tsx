import { useTranslate } from '@/i18n/use-translate'
import { SettingsRow, SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { getWorkspaceCleanupSettingsSearchParts } from './workspace-cleanup-settings-search'

/** What cleanup never removes, and whether ignored files also keep a workspace. */
export function WorkspaceCleanupProtectionSection({
  keepIgnoredFiles,
  disabled,
  onToggleKeepIgnoredFiles
}: {
  keepIgnoredFiles: boolean
  disabled: boolean
  onToggleKeepIgnoredFiles: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const search = getWorkspaceCleanupSettingsSearchParts()
  return (
    <SettingsGroup title={t('components.settings.workspaceCleanup.protection.title', 'Protection')}>
      <SettingsRow
        label={t('components.settings.workspaceCleanup.protection.alwaysKeptLabel', 'Always kept')}
        description={t(
          'components.settings.workspaceCleanup.protection.alwaysKeptList',
          'Pinned workspaces, running agents or terminals, unsaved editor changes, uncommitted changes, unpushed commits.'
        )}
        control={null}
      />
      <SearchableSetting {...search.keepIgnoredFiles}>
        <SettingsSwitchRow
          label={search.keepIgnoredFiles.title}
          description={search.keepIgnoredFiles.description}
          checked={keepIgnoredFiles}
          disabled={disabled}
          onChange={onToggleKeepIgnoredFiles}
        />
      </SearchableSetting>
    </SettingsGroup>
  )
}
