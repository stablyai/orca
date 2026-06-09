import type React from 'react'
import { FolderOpen } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { OpenInMenuSetting } from './OpenInMenuSetting'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

type GeneralWorkspaceSettingsSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function GeneralWorkspaceSettingsSection({
  settings,
  updateSettings
}: GeneralWorkspaceSettingsSectionProps): React.JSX.Element {
  const handleBrowseWorkspace = async (): Promise<void> => {
    const path = await window.api.repos.pickFolder()
    if (path) {
      updateSettings({ workspaceDir: path })
    }
  }

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

      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralWorkspaceSettingsSection.0e9fc0eadc',
          'Workspace Directory'
        )}
        description={translate(
          'auto.components.settings.GeneralWorkspaceSettingsSection.a246f5ce6f',
          'Root directory where workspace folders are created.'
        )}
        keywords={['workspace', 'folder', 'path', 'worktree']}
        className="space-y-2"
      >
        <Label>
          {translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.0e9fc0eadc',
            'Workspace Directory'
          )}
        </Label>
        <div className="flex gap-2">
          <Input
            value={settings.workspaceDir}
            onChange={(e) => updateSettings({ workspaceDir: e.target.value })}
            className="flex-1 text-xs"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleBrowseWorkspace}
            className="shrink-0 gap-1.5"
          >
            <FolderOpen className="size-3.5" />
            {translate(
              'auto.components.settings.GeneralWorkspaceSettingsSection.5567191a6e',
              'Browse'
            )}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.GeneralWorkspaceSettingsSection.a246f5ce6f',
            'Root directory where workspace folders are created.'
          )}
        </p>
      </SearchableSetting>

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
