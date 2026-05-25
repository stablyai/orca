import React from 'react'
import type { CtrlTabOrderMode } from '../../../../shared/types'
import type { TerminalShortcutPolicy } from '../../../../shared/keybindings'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow } from './SettingsFormControls'

export function ShortcutPolicyControls({
  showPolicy,
  showCtrlTab,
  terminalShortcutPolicy,
  ctrlTabOrderMode,
  terminalShortcutPolicyKeywords,
  ctrlTabKeywords,
  updateSettings
}: {
  showPolicy: boolean
  showCtrlTab: boolean
  terminalShortcutPolicy: TerminalShortcutPolicy
  ctrlTabOrderMode: CtrlTabOrderMode
  terminalShortcutPolicyKeywords?: string[]
  ctrlTabKeywords?: string[]
  updateSettings: (updates: {
    terminalShortcutPolicy?: TerminalShortcutPolicy
    ctrlTabOrderMode?: CtrlTabOrderMode
  }) => Promise<void> | void
}): React.JSX.Element | null {
  if (!showPolicy && !showCtrlTab) {
    return null
  }

  return (
    <div className="divide-y divide-border/40">
      {showPolicy ? (
        <SearchableSetting
          id="terminal-shortcut-policy"
          title="Shortcuts in Terminal"
          description="Choose whether Orca or the focused terminal wins when shortcuts overlap."
          keywords={terminalShortcutPolicyKeywords}
          className="max-w-none"
        >
          <SettingsRow
            label="Shortcuts in Terminal"
            description="Orca first keeps app shortcuts active in TUIs. Terminal first lets shell shortcuts win unless marked terminal-active."
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
      ) : null}

      {showCtrlTab ? (
        <SearchableSetting
          title="Recent Tab Order"
          description="Choose recent or sequential tab switching."
          keywords={ctrlTabKeywords}
          className="max-w-none"
        >
          <SettingsRow
            label="Recent Tab Order"
            description="Choose whether recent tab switching follows recent use or the tab strip order."
            control={
              <Select
                value={ctrlTabOrderMode}
                onValueChange={(value) =>
                  void updateSettings({ ctrlTabOrderMode: value as CtrlTabOrderMode })
                }
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mru">Most recent</SelectItem>
                  <SelectItem value="sequential">Tab strip order</SelectItem>
                </SelectContent>
              </Select>
            }
          />
        </SearchableSetting>
      ) : null}
    </div>
  )
}
