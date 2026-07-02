import type React from 'react'
import { useAppStore } from '../../store'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

export function AutomaticUpdatesSetting(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const enabled = settings?.automaticUpdates === true

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.GeneralUpdateSettingsSection.a73f0c19be',
        'Automatic updates'
      )}
      description={translate(
        'auto.components.settings.GeneralUpdateSettingsSection.b8e724f0d3',
        'Download new updates automatically in the background. Once an update is downloaded, Orca installs it the next time you quit — your terminal sessions are never interrupted.'
      )}
      keywords={['update', 'automatic', 'auto', 'background', 'download', 'install']}
    >
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.GeneralUpdateSettingsSection.a73f0c19be',
          'Automatic updates'
        )}
        description={translate(
          'auto.components.settings.GeneralUpdateSettingsSection.b8e724f0d3',
          'Download new updates automatically in the background. Once an update is downloaded, Orca installs it the next time you quit — your terminal sessions are never interrupted.'
        )}
        checked={enabled}
        onChange={() => updateSettings({ automaticUpdates: !enabled })}
      />
    </SearchableSetting>
  )
}
