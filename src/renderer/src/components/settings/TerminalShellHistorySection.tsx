import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { getTerminalShellHistorySearchEntry } from './terminal-shell-history-search'

type TerminalShellHistorySectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalShellHistorySection({
  settings,
  updateSettings
}: TerminalShellHistorySectionProps): React.JSX.Element {
  const searchEntry = getTerminalShellHistorySearchEntry()

  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.TerminalShellHistorySection.title',
          'Shell History'
        )}
        description={translate(
          'auto.components.settings.TerminalShellHistorySection.description',
          "Choose whether new terminal sessions use workspace-only or your shell's normal history."
        )}
      />

      <div className="divide-y divide-border/40">
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
      </div>
    </section>
  )
}
