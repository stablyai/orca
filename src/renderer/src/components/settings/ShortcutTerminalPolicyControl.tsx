import React from 'react'
import type {
  ResolvedTerminalShortcutPolicy,
  TerminalShortcutPolicy
} from '../../../../shared/keybindings'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

export function ShortcutTerminalPolicyControl({
  terminalShortcutPolicy,
  keywords,
  updateSettings
}: {
  terminalShortcutPolicy: ResolvedTerminalShortcutPolicy
  keywords?: string[]
  updateSettings: (updates: {
    terminalShortcutPolicy?: TerminalShortcutPolicy
    terminalSearchShortcutInTerminalFirst?: boolean
  }) => Promise<void> | void
}): React.JSX.Element {
  return (
    <SearchableSetting
      id="terminal-shortcut-policy"
      title={translate(
        'auto.components.settings.ShortcutTerminalPolicyControl.c3a554288e',
        'Shortcuts in Terminal'
      )}
      description={translate(
        'auto.components.settings.ShortcutTerminalPolicyControl.0f55c6f15c',
        'Choose whether Orca or the focused terminal wins when shortcuts overlap.'
      )}
      keywords={keywords}
      className="max-w-none"
    >
      <SettingsRow
        label={translate(
          'auto.components.settings.ShortcutTerminalPolicyControl.c3a554288e',
          'Shortcuts in Terminal'
        )}
        description={translate(
          'auto.components.settings.ShortcutTerminalPolicyControl.c43c7ff5f9',
          'Decide who first intercepts shortcuts'
        )}
        control={
          <Select
            value={terminalShortcutPolicy}
            onValueChange={(value) => {
              if (
                value !== 'orca-first' &&
                value !== 'terminal-first' &&
                value !== 'terminal-first-with-search'
              ) {
                return
              }
              void updateSettings({
                terminalShortcutPolicy: value === 'orca-first' ? 'orca-first' : 'terminal-first',
                terminalSearchShortcutInTerminalFirst: value === 'terminal-first-with-search'
              })
            }}
          >
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="orca-first">
                {translate(
                  'auto.components.settings.ShortcutTerminalPolicyControl.63308571d8',
                  'Orca first'
                )}
              </SelectItem>
              <SelectItem value="terminal-first">
                {translate(
                  'auto.components.settings.ShortcutTerminalPolicyControl.0762983d13',
                  'Terminal first'
                )}
              </SelectItem>
              <SelectItem value="terminal-first-with-search">
                {translate(
                  'settings.shortcuts.terminalFirstWithSearch',
                  'Terminal first, Orca search'
                )}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
      {terminalShortcutPolicy === 'terminal-first-with-search' ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'settings.shortcuts.terminalFirstWithSearchDescription',
            'Search active pane opens Orca search. Other shortcuts keep Terminal first behavior.'
          )}
        </p>
      ) : null}
    </SearchableSetting>
  )
}
