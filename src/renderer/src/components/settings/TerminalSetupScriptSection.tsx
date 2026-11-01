import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { getTerminalSetupScriptSearchEntries } from './terminal-window-setup-search'
import { translate } from '@/i18n/i18n'

type TerminalSetupScriptSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalSetupScriptSection({
  settings,
  updateSettings
}: TerminalSetupScriptSectionProps): React.JSX.Element {
  const [entry] = getTerminalSetupScriptSearchEntries()
  return (
    <section key="setup-script" className="space-y-3">
      <SettingsSubsectionHeader
        title={translate('components.settings.TerminalSetupScript.title', 'Workspace Setup Script')}
        description={translate(
          'components.settings.TerminalSetupScript.description',
          'The repository setup script runs in a background "Setup" tab when a new workspace is created.'
        )}
      />

      <div className="divide-y divide-border/40">
        <SearchableSetting
          title={entry.title}
          description={entry.description}
          keywords={entry.keywords}
        >
          <SettingsSwitchRow
            label={entry.title}
            description={entry.description}
            checked={settings.closeSetupTabOnSuccess}
            onChange={() =>
              updateSettings({ closeSetupTabOnSuccess: !settings.closeSetupTabOnSuccess })
            }
          />
        </SearchableSetting>
      </div>
    </section>
  )
}
