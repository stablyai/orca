import type { GlobalSettings } from '../../../../shared/types'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

type TerminalBehaviorSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalBehaviorSection({
  settings,
  updateSettings
}: TerminalBehaviorSectionProps): React.JSX.Element {
  return (
    <section key="behavior" className="space-y-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.TerminalPane.behavior_title',
          'Terminal Behavior'
        )}
        description={translate(
          'auto.components.settings.TerminalPane.behavior_description',
          'Command input behavior for terminal panes.'
        )}
      />

      <div className="divide-y divide-border/40">
        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalPane.autosuggest_title',
            'Command Autosuggest'
          )}
          description={translate(
            'auto.components.settings.TerminalPane.autosuggest_description',
            'Show an inline suggestion from prior commands as you type; accept with the Right Arrow or End key.'
          )}
          keywords={['autosuggest', 'autocomplete', 'suggestion', 'history', 'ghost text']}
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.TerminalPane.autosuggest_title',
              'Command Autosuggest'
            )}
            description={translate(
              'auto.components.settings.TerminalPane.autosuggest_description',
              'Show an inline suggestion from prior commands as you type; accept with the Right Arrow or End key.'
            )}
            checked={settings.terminalAutosuggestEnabled}
            onChange={() =>
              updateSettings({ terminalAutosuggestEnabled: !settings.terminalAutosuggestEnabled })
            }
          />
        </SearchableSetting>
      </div>
    </section>
  )
}
