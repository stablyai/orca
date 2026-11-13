import { GENERAL_SETTING_ANCHORS } from './general-setting-anchors'
import { getGeneralSubPageTitle, type GeneralSubPage } from './general-sub-pages'
import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { OpenInMenuEditor, type useOpenInMenuDraft } from './OpenInMenuSetting'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { WorkspaceDirectorySetting } from './WorkspaceDirectorySetting'
import { useTranslate } from '@/i18n/use-translate'
import { GlobalWorktreeVisibilitySourcesSetting } from './GlobalWorktreeVisibilitySourcesSetting'
import { GLOBAL_WORKTREE_VISIBILITY_SETTINGS_TARGET_ID } from '@/components/settings/navigation/settings-navigation-types'
import { SettingsGroup } from '../section-layout/SettingsGroup'

type GeneralWorkspaceSettingsSectionProps = {
  openInDraft: ReturnType<typeof useOpenInMenuDraft>
  page: GeneralSubPage
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  updateSettingsOrThrow?: (updates: Partial<GlobalSettings>) => void | Promise<void>
  defaultsSupported?: boolean
  sourceDefaultsSupported?: boolean
}

export function GeneralWorkspaceSettingsSection({
  page,
  openInDraft,
  settings,
  updateSettings,
  updateSettingsOrThrow = updateSettings,
  defaultsSupported = true,
  sourceDefaultsSupported = true
}: GeneralWorkspaceSettingsSectionProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsGroup title={getGeneralSubPageTitle(page, t)}>
      {page === 'folder' ? (
        <div>
          <WorkspaceDirectorySetting settings={settings} updateSettings={updateSettings} />
          <SearchableSetting
            id={GENERAL_SETTING_ANCHORS.nesting}
            title={t('settings.general.folder.perProject', 'Folder per project')}
            description={t(
              'auto.components.settings.GeneralWorkspaceSettingsSection.4fbf910ded',
              'Create workspaces inside a repo-named subfolder.'
            )}
            keywords={[
              'nest',
              'nested',
              'subfolder',
              'directory',
              t(
                'auto.components.settings.GeneralWorkspaceSettingsSection.a8ce626e4b',
                'Nest workspaces'
              )
            ]}
          >
            <SettingsSwitchRow
              label={t('settings.general.folder.perProject', 'Folder per project')}
              description={t(
                'auto.components.settings.GeneralWorkspaceSettingsSection.4fbf910ded',
                'Create workspaces inside a repo-named subfolder.'
              )}
              checked={settings.nestWorkspaces}
              onChange={() => updateSettings({ nestWorkspaces: !settings.nestWorkspaces })}
            />
          </SearchableSetting>
        </div>
      ) : page === 'worktrees' ? (
        <div
          data-settings-section={GLOBAL_WORKTREE_VISIBILITY_SETTINGS_TARGET_ID}
          className="scroll-mt-6"
        >
          <SearchableSetting
            id={GENERAL_SETTING_ANCHORS.worktrees}
            title={t(
              'auto.components.settings.GeneralWorkspaceSettingsSection.externalWorktrees',
              'External worktrees'
            )}
            description={t(
              'auto.components.settings.GeneralWorkspaceSettingsSection.externalWorktreesDescription',
              'Choose which worktrees created outside Orca appear by default on this host.'
            )}
            className="py-3"
            keywords={[
              'external',
              'non-Orca',
              'worktree',
              'visibility',
              'sidebar',
              'show',
              'hide',
              'source',
              'location',
              'root',
              'Claude',
              'GSD'
            ]}
          >
            <GlobalWorktreeVisibilitySourcesSetting
              settings={settings}
              defaultsSupported={defaultsSupported}
              sourceDefaultsSupported={sourceDefaultsSupported}
              updateSettings={updateSettingsOrThrow}
            />
          </SearchableSetting>
        </div>
      ) : (
        <div data-settings-section="general-open-in-apps" className="scroll-mt-6">
          <SearchableSetting
            id={GENERAL_SETTING_ANCHORS.openIn}
            title={t(
              'auto.components.settings.GeneralWorkspaceSettingsSection.ad65d146f6',
              'Open in apps'
            )}
            description={t(
              'auto.components.settings.GeneralWorkspaceSettingsSection.3d538a98f7',
              "Choose apps available from a workspace's Open in menu."
            )}
            keywords={[
              'open in',
              'open menu',
              'editor',
              'launcher',
              'cursor',
              'zed',
              'windsurf',
              'devin',
              'devin desktop',
              'antigravity',
              'command',
              'vscode',
              'finder',
              'file explorer'
            ]}
            className="space-y-3 py-3"
          >
            <OpenInMenuEditor
              draftOwner={openInDraft}
              applications={settings.openInApplications}
              updateSettings={updateSettings}
            />
          </SearchableSetting>
        </div>
      )}
    </SettingsGroup>
  )
}
