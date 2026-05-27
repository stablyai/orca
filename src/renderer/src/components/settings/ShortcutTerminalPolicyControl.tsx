import React from 'react'
import type { TerminalShortcutPolicy } from '../../../../shared/keybindings'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow } from './SettingsFormControls'

export function ShortcutTerminalPolicyControl({
  terminalShortcutPolicy,
  keywords,
  updateSettings
}: {
  terminalShortcutPolicy: TerminalShortcutPolicy
  keywords?: string[]
  updateSettings: (updates: {
    terminalShortcutPolicy?: TerminalShortcutPolicy
  }) => Promise<void> | void
}): React.JSX.Element {
  return (
    <SearchableSetting
      id="terminal-shortcut-policy"
      title="Shortcuts in Terminal"
      description="Choose whether Orca or the focused terminal wins when shortcuts overlap."
      keywords={keywords}
      className="max-w-none"
    >
      <SettingsRow
        label="Shortcuts in Terminal"
        description="Decide who first intercepts shortcuts"
        control={
          <Select
            value={terminalShortcutPolicy}
            onValueChange={(value) =>
              void updateSettings({
                terminalShortcutPolicy: value as TerminalShortcutPolicy
              })
            }
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="orca-first">Orca first</SelectItem>
              <SelectItem value="terminal-first">Terminal first</SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SearchableSetting>
  )
}
