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

  return (
    <SearchableSetting {...searchEntry}>
      <SettingsSwitchRow
        label={searchEntry.title}
        description={searchEntry.description}
        checked={settings.terminalScopeHistoryByWorktree}
        onChange={() =>
          updateSettings({
            terminalScopeHistoryByWorktree: !settings.terminalScopeHistoryByWorktree
          })
        }
      />
    </SearchableSetting>
  )
}
