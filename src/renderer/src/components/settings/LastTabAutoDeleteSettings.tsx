import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  readLastTabAutoDeleteMode,
  type LastTabAutoDeleteMode
} from '../../../../shared/worktree-deletion-preferences'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

const MODES: readonly LastTabAutoDeleteMode[] = [
  'off',
  'close',
  'close-or-exit',
  'close-or-exit-background'
]

function modeLabel(mode: LastTabAutoDeleteMode): string {
  switch (mode) {
    case 'off':
      return translate('auto.components.settings.LastTabAutoDeleteSettings.3ee0224127', 'Off')
    case 'close':
      return translate(
        'auto.components.settings.LastTabAutoDeleteSettings.5c40d319f9',
        'When I close it'
      )
    case 'close-or-exit':
      return translate(
        'auto.components.settings.LastTabAutoDeleteSettings.b5728ff9e4',
        'When I close it or its process exits'
      )
    case 'close-or-exit-background':
      return translate(
        'auto.components.settings.LastTabAutoDeleteSettings.32dac2fdaf',
        'Also when a process exits in a background workspace'
      )
  }
}

function isLastTabAutoDeleteMode(value: string): value is LastTabAutoDeleteMode {
  return (MODES as readonly string[]).includes(value)
}

export function LastTabAutoDeleteSettings({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const mode = readLastTabAutoDeleteMode(settings.deleteWorkspaceOnLastTabClose)
  const skipPinned = settings.lastTabDeleteSkipPinned ?? true
  const skipFolder = settings.lastTabDeleteSkipFolder ?? false
  const skipSsh = settings.lastTabDeleteSkipSsh ?? false
  const title = translate(
    'auto.components.settings.LastTabAutoDeleteSettings.487076ea0d',
    'Delete Workspace When Its Last Tab Closes'
  )
  return (
    <SearchableSetting
      title={title}
      description={translate(
        'auto.components.settings.LastTabAutoDeleteSettings.08de07fd0a',
        'Run the normal workspace delete when closing a tab leaves its workspace empty.'
      )}
      keywords={['delete', 'workspace', 'last tab', 'close', 'exit', 'auto', 'remove']}
    >
      <SettingsRow
        label={title}
        description={translate(
          'auto.components.settings.LastTabAutoDeleteSettings.08f6a8b79d',
          'Uses the same confirmation as deleting from the sidebar. With the exit options a delete can start without a keypress, but a workspace with uncommitted changes always asks first. The main workspace is never deleted.'
        )}
        control={
          <Select
            value={mode}
            onValueChange={(value) => {
              if (isLastTabAutoDeleteMode(value)) {
                updateSettings({ deleteWorkspaceOnLastTabClose: value })
              }
            }}
          >
            <SelectTrigger size="sm" className="h-7 w-[220px] text-xs" aria-label={title}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODES.map((value) => (
                <SelectItem key={value} value={value}>
                  {modeLabel(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <div className="pl-4">
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.LastTabAutoDeleteSettings.a5c235b455',
            'Skip Pinned Workspaces'
          )}
          description={translate(
            'auto.components.settings.LastTabAutoDeleteSettings.61fb0b6bd1',
            'Keep pinned workspaces when their last tab closes.'
          )}
          checked={skipPinned}
          disabled={mode === 'off'}
          onChange={() => updateSettings({ lastTabDeleteSkipPinned: !skipPinned })}
        />
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.LastTabAutoDeleteSettings.4fcf8e43fb',
            'Skip Folder Workspaces'
          )}
          description={translate(
            'auto.components.settings.LastTabAutoDeleteSettings.c27462f864',
            'Keep folder workspaces when their last tab closes. Their files stay on disk either way.'
          )}
          checked={skipFolder}
          disabled={mode === 'off'}
          onChange={() => updateSettings({ lastTabDeleteSkipFolder: !skipFolder })}
        />
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.LastTabAutoDeleteSettings.c9b7aeaf31',
            'Skip SSH Workspaces'
          )}
          description={translate(
            'auto.components.settings.LastTabAutoDeleteSettings.f486c0aeac',
            'Keep workspaces on SSH hosts when their last tab closes.'
          )}
          checked={skipSsh}
          disabled={mode === 'off'}
          onChange={() => updateSettings({ lastTabDeleteSkipSsh: !skipSsh })}
        />
      </div>
    </SearchableSetting>
  )
}
