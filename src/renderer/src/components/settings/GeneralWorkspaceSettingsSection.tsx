import type React from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { OpenInMenuSetting } from './OpenInMenuSetting'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { WorkspaceDirectorySetting } from './WorkspaceDirectorySetting'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { translate } from '@/i18n/i18n'

type GeneralWorkspaceSettingsSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function GeneralWorkspaceSettingsSection({
  settings,
  updateSettings
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

      <div id="general-confirm-file-explorer-move" className="scroll-mt-6">
        <SearchableSetting
          title={translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.confirmFileExplorerMove',
            'Confirm Before Moving Files in Explorer'
          )}
          description={translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.confirmFileExplorerMoveDescription',
            'Show a confirmation dialog before drag-moving files or folders in the File Explorer.'
          )}
          keywords={[
            'move',
            'drag',
            'drop',
            'explorer',
            'confirm',
            'dialog',
            'file',
            'folder',
            'directory'
          ]}
        >
          <SettingsRow
            labelId="confirm-file-explorer-move-label"
            label={translate(
              'auto.components.settings.GeneralWorkspaceSettingsSection.confirmFileExplorerMove',
              'Confirm Before Moving Files in Explorer'
            )}
            description={translate(
              'auto.components.settings.GeneralWorkspaceSettingsSection.confirmFileExplorerMoveHint',
              'Never keeps silent moves. Directories only prompts for folder moves. Always prompts for every drag-move.'
            )}
            control={
              <Select
                value={settings.confirmFileExplorerMove ?? 'never'}
                onValueChange={(value) => {
                  if (value === 'never' || value === 'directories' || value === 'always') {
                    updateSettings({ confirmFileExplorerMove: value })
                  }
                }}
              >
                <SelectTrigger
                  aria-labelledby="confirm-file-explorer-move-label"
                  size="sm"
                  className="w-[160px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="never">
                    {translate(
                      'auto.components.settings.GeneralWorkspaceSettingsSection.confirmFileExplorerMove.never',
                      'Never'
                    )}
                  </SelectItem>
                  <SelectItem value="directories">
                    {translate(
                      'auto.components.settings.GeneralWorkspaceSettingsSection.confirmFileExplorerMove.directories',
                      'Directories only'
                    )}
                  </SelectItem>
                  <SelectItem value="always">
                    {translate(
                      'auto.components.settings.GeneralWorkspaceSettingsSection.confirmFileExplorerMove.always',
                      'Always'
                    )}
                  </SelectItem>
                </SelectContent>
              </Select>
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
