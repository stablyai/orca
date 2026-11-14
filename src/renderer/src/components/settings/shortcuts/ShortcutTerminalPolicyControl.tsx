import React from 'react'
import type { TerminalShortcutPolicy } from '../../../../../shared/keybindings/types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import { useTranslate } from '@/i18n/use-translate'

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
  const t = useTranslate()
  return (
    <SearchableSetting
      id="terminal-shortcut-policy"
      title={t(
        'auto.components.settings.ShortcutTerminalPolicyControl.7d81bebd89',
        'Shortcuts in terminal'
      )}
      description={t(
        'auto.components.settings.ShortcutTerminalPolicyControl.0f55c6f15c',
        'Choose whether Orca or the focused terminal wins when shortcuts overlap.'
      )}
      keywords={keywords}
      className="max-w-none"
    >
      <SettingsRow
        label={t(
          'auto.components.settings.ShortcutTerminalPolicyControl.7d81bebd89',
          'Shortcuts in terminal'
        )}
        description={t(
          'auto.components.settings.ShortcutTerminalPolicyControl.c43c7ff5f9',
          'Decide who first intercepts shortcuts'
        )}
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
              <SelectItem value="orca-first">
                {t(
                  'auto.components.settings.ShortcutTerminalPolicyControl.63308571d8',
                  'Orca first'
                )}
              </SelectItem>
              <SelectItem value="terminal-first">
                {t(
                  'auto.components.settings.ShortcutTerminalPolicyControl.0762983d13',
                  'Terminal first'
                )}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
    </SearchableSetting>
  )
}
