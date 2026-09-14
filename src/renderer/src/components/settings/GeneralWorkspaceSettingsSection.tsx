import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { OpenInMenuSetting } from './OpenInMenuSetting'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { WorkspaceDirectorySetting } from './WorkspaceDirectorySetting'
import { translate } from '@/i18n/i18n'
import { GlobalWorktreeVisibilitySourcesSetting } from './GlobalWorktreeVisibilitySourcesSetting'
import { GLOBAL_WORKTREE_VISIBILITY_SETTINGS_TARGET_ID } from '@/lib/settings-navigation-types'

type GeneralWorkspaceSettingsSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  updateSettingsOrThrow?: (updates: Partial<GlobalSettings>) => void | Promise<void>
  defaultsSupported?: boolean
  sourceDefaultsSupported?: boolean
}

export function GeneralWorkspaceSettingsSection({
  settings,
  updateSettings,
  updateSettingsOrThrow = updateSettings,
  defaultsSupported = true,
  sourceDefaultsSupported = true
}: GeneralWorkspaceSettingsSectionProps): React.JSX.Element {
  return (
    <section key="workspace" className="space-y-4">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.GeneralWorkspaceSettingsSection.7511097c5d',
          'Workspace'
        )}
        description={translate(
          'auto.components.settings.GeneralWorkspaceSettingsSection.e2955d9ccb',
          'Configure where new workspaces are created.'
        )}
      />

      <WorkspaceDirectorySetting settings={settings} updateSettings={updateSettings} />

      <div
        id={GLOBAL_WORKTREE_VISIBILITY_SETTINGS_TARGET_ID}
        data-settings-section={GLOBAL_WORKTREE_VISIBILITY_SETTINGS_TARGET_ID}
        className="scroll-mt-6"
      >
        <SearchableSetting
          title={translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.externalWorktrees',
            'External worktrees'
          )}
          description={translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.externalWorktreesDescription',
            'Choose which worktrees created outside Orca appear by default on this host.'
          )}
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

      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralWorkspaceSettingsSection.ba3480642f',
          'Nest Workspaces'
        )}
        description={translate(
          'auto.components.settings.GeneralWorkspaceSettingsSection.4fbf910ded',
          'Create workspaces inside a repo-named subfolder.'
        )}
        keywords={['nested', 'subfolder', 'directory']}
      >
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.ba3480642f',
            'Nest Workspaces'
          )}
          description={translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.4fbf910ded',
            'Create workspaces inside a repo-named subfolder.'
          )}
          checked={settings.nestWorkspaces}
          onChange={() => updateSettings({ nestWorkspaces: !settings.nestWorkspaces })}
        />
      </SearchableSetting>

      {/* Why: the "Don't ask again" toast in the delete-worktree dialog
          deep-links here, so the wrapper id must stay stable. Renaming it
          breaks that toast action even though this pane still renders fine. */}
      <div id="general-skip-delete-worktree-confirm" className="scroll-mt-6">
        <SearchableSetting
          title={translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.9f380934cf',
            'Ask Before Deleting Workspaces'
          )}
          description={translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.5734db82af',
            'Show a confirmation dialog before deleting a workspace.'
          )}
          keywords={['delete', 'worktree', 'confirm', 'dialog', 'skip', 'prompt']}
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.GeneralWorkspaceSettingsSection.9f380934cf',
              'Ask Before Deleting Workspaces'
            )}
            description={translate(
              'auto.components.settings.GeneralWorkspaceSettingsSection.28bc3d085e',
              'Show a confirmation before deleting a workspace from the context menu. Failed deletes still surface a Force Delete fallback.'
            )}
            checked={!settings.skipDeleteWorktreeConfirm}
            onChange={() =>
              updateSettings({
                skipDeleteWorktreeConfirm: !settings.skipDeleteWorktreeConfirm
              })
            }
          />
        </SearchableSetting>
      </div>

      <div id="general-skip-delete-automation-confirm" className="scroll-mt-6">
        <SearchableSetting
          title={translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.ea98373cd8',
            'Ask Before Deleting Automations'
          )}
          description={translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.d2dd2ca2e3',
            'Show a confirmation dialog before deleting an automation and its run history.'
          )}
          keywords={['delete', 'automation', 'confirm', 'dialog', 'skip', 'prompt']}
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.GeneralWorkspaceSettingsSection.ea98373cd8',
              'Ask Before Deleting Automations'
            )}
            description={translate(
              'auto.components.settings.GeneralWorkspaceSettingsSection.824b98a0d9',
              'Show a confirmation before deleting automations and their run history.'
            )}
            checked={!settings.skipDeleteAutomationConfirm}
            onChange={() =>
              updateSettings({
                skipDeleteAutomationConfirm: !settings.skipDeleteAutomationConfirm
              })
            }
          />
        </SearchableSetting>
      </div>

      <div id="general-skip-delete-artifact-confirm" className="scroll-mt-6">
        <SearchableSetting
          title={translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.31e300af1c',
            'Ask Before Deleting Artifacts'
          )}
          description={translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.fb29a73a17',
            'Show a confirmation dialog before deleting a shared artifact and breaking its public link.'
          )}
          keywords={['delete', 'artifact', 'share', 'link', 'confirm', 'dialog', 'skip', 'prompt']}
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.GeneralWorkspaceSettingsSection.31e300af1c',
              'Ask Before Deleting Artifacts'
            )}
            description={translate(
              'auto.components.settings.GeneralWorkspaceSettingsSection.bf46474e33',
              'Show a confirmation before deleting a shared artifact. Anyone holding its public link loses access.'
            )}
            checked={!settings.skipDeleteArtifactConfirm}
            onChange={() =>
              updateSettings({
                skipDeleteArtifactConfirm: !settings.skipDeleteArtifactConfirm
              })
            }
          />
        </SearchableSetting>
      </div>

      <div
        id="general-open-in-apps"
        data-settings-section="general-open-in-apps"
        className="scroll-mt-6"
      >
        <SearchableSetting
          title={translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.008f92085f',
            'Open In Apps'
          )}
          description={translate(
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
            'command',
            'vscode',
            'finder',
            'file explorer'
          ]}
          className="space-y-3"
        >
          <OpenInMenuSetting
            applications={settings.openInApplications}
            updateSettings={updateSettings}
          />
        </SearchableSetting>
      </div>
    </section>
  )
}
