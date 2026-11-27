import { defineFixture } from '../../../component-fixtures/component-fixture'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SettingsNavigationRow } from './SettingsNavigationRow'

function WorkspacesGroup(): React.JSX.Element {
  return (
    <div className="settings-view-shell p-4">
      <div>
        <SettingsGroup title="Workspaces">
          <SettingsNavigationRow
            title="Workspace folder"
            description="~/orca/workspaces"
            value="Folder per project"
            onClick={() => {}}
          />
          <SettingsNavigationRow
            title="Worktrees from other tools"
            description="Claude Code, GSD and other locations"
            value="2 of 3 shown"
            onClick={() => {}}
          />
          <SettingsNavigationRow
            title="Open in"
            description="Apps in a workspace’s Open in menu"
            value="Finder, Terminal"
            onClick={() => {}}
          />
        </SettingsGroup>
      </div>
    </div>
  )
}

export const workspaces = defineFixture({ width: 640, render: () => <WorkspacesGroup /> })

export const narrow = defineFixture({ width: 320, render: () => <WorkspacesGroup /> })
