import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { SettingsFileStatus } from '../../../../../shared/settings/settings-file/settings-file-status-types'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SettingsFileSettingView } from './SettingsFileSetting'

const PATH = '/Users/example/.orca/settings.json'

function SettingsFileFixture({ status }: { status: SettingsFileStatus }): React.JSX.Element {
  return (
    <div className="settings-view-shell bg-background p-8 text-foreground">
      <SettingsGroup>
        <SettingsFileSettingView
          status={status}
          pending={false}
          onCreate={() => {}}
          onOpen={() => {}}
        />
      </SettingsGroup>
    </div>
  )
}

export const absent = defineFixture({
  width: 720,
  render: () => (
    <SettingsFileFixture
      status={{ state: 'absent', path: PATH, appliedKeyCount: 0, ignored: [] }}
    />
  )
})

export const activeWithIgnored = defineFixture({
  width: 720,
  render: () => (
    <SettingsFileFixture
      status={{
        state: 'active',
        path: PATH,
        appliedKeyCount: 24,
        ignored: [
          { key: 'terminalFontSize', reason: 'invalid-value' },
          { key: 'workspaceDir', reason: 'not-portable' },
          { key: 'anthropicApiKey', reason: 'not-portable' },
          { key: 'theem', reason: 'unknown' },
          { key: 'editorFontSise', reason: 'unknown' },
          { key: 'sidebarWidth', reason: 'not-portable' },
          { key: 'notificationsEnabled', reason: 'invalid-value' }
        ]
      }}
    />
  )
})

export const invalid = defineFixture({
  width: 720,
  render: () => (
    <SettingsFileFixture
      status={{
        state: 'invalid',
        path: PATH,
        appliedKeyCount: 0,
        ignored: [],
        message: 'Unexpected token } in JSON at line 12'
      }}
    />
  )
})

export const readOnly = defineFixture({
  width: 720,
  render: () => (
    <SettingsFileFixture
      status={{ state: 'read-only', path: PATH, appliedKeyCount: 24, ignored: [] }}
    />
  )
})
