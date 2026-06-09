import type React from 'react'
import { FolderOpen } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { OpenInMenuSetting } from './OpenInMenuSetting'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'

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
        title="Workspace"
        description="Configure where new workspaces are created."
      />

      <SearchableSetting
        title="Workspace Directory"
        description="Root directory where workspace folders are created."
        keywords={['workspace', 'folder', 'path', 'worktree']}
        className="space-y-2"
      >
        <Label>Workspace Directory</Label>
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
            Browse
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Root directory where workspace folders are created.
        </p>
      </SearchableSetting>

      <SearchableSetting
        title="Nest Workspaces"
        description="Create workspaces inside a repo-named subfolder."
        keywords={['nested', 'subfolder', 'directory']}
      >
        <SettingsSwitchRow
          label="Nest Workspaces"
          description="Create workspaces inside a repo-named subfolder."
          checked={settings.nestWorkspaces}
          onChange={() => updateSettings({ nestWorkspaces: !settings.nestWorkspaces })}
        />
      </SearchableSetting>

      {/* Why: the "Don't ask again" toast in the delete-worktree dialog
          deep-links here, so the wrapper id must stay stable. Renaming it
          breaks that toast action even though this pane still renders fine. */}
      <div id="general-skip-delete-worktree-confirm" className="scroll-mt-6">
        <SearchableSetting
          title="Ask Before Deleting Workspaces"
          description="Show a confirmation dialog before deleting a workspace."
          keywords={['delete', 'worktree', 'confirm', 'dialog', 'skip', 'prompt']}
        >
          <SettingsSwitchRow
            label="Ask Before Deleting Workspaces"
            description="Show a confirmation before deleting a workspace from the context menu. Failed deletes still surface a Force Delete fallback."
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
          title="Ask Before Deleting Automations"
          description="Show a confirmation dialog before deleting an automation and its run history."
          keywords={['delete', 'automation', 'confirm', 'dialog', 'skip', 'prompt']}
        >
          <SettingsSwitchRow
            label="Ask Before Deleting Automations"
            description="Show a confirmation before deleting automations and their run history."
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
          title="Open In Apps"
          description="Choose apps available from a workspace's Open in menu."
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
