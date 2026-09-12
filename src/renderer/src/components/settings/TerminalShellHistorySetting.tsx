import { useRef, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { getTerminalShellHistorySearchEntry } from './terminal-shell-history-search'

type TerminalShellHistorySettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalShellHistorySetting({
  settings,
  updateSettings
}: TerminalShellHistorySettingProps): React.JSX.Element {
  const searchEntry = getTerminalShellHistorySearchEntry()
  const [pendingChecked, setPendingChecked] = useState<boolean | null>(null)
  const writePendingRef = useRef(false)
  const handleChange = (checked: boolean): void => {
    if (writePendingRef.current) {
      return
    }
    writePendingRef.current = true
    setPendingChecked(checked)
    void Promise.resolve(updateSettings({ terminalScopeHistoryByWorktree: checked })).finally(
      () => {
        writePendingRef.current = false
        setPendingChecked(null)
      }
    )
  }

  return (
    <SearchableSetting {...searchEntry}>
      <SettingsSwitchRow
        label={searchEntry.title}
        description={searchEntry.description}
        checked={pendingChecked ?? settings.terminalScopeHistoryByWorktree}
        disabled={pendingChecked !== null}
        onChange={handleChange}
      />
    </SearchableSetting>
  )
}
