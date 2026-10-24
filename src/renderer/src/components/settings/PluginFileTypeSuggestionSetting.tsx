import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { SettingsRow, SettingsSwitch } from './SettingsFormControls'

export function PluginFileTypeSuggestionSetting(): React.JSX.Element {
  const enabled = useAppStore((state) => state.settings?.pluginFileTypeSuggestions !== false)
  const updateSettings = useAppStore((state) => state.updateSettings)
  return (
    <SettingsRow
      label={translate(
        'auto.components.settings.PluginsSettingsSection.fileTypeSuggestionsLabel',
        'Suggest plugins for unknown files'
      )}
      labelId="plugin-file-type-suggestions-label"
      description={translate(
        'auto.components.settings.PluginsSettingsSection.fileTypeSuggestionsDescription',
        'Offer a catalog plugin when Orca can’t open or highlight a file.'
      )}
      control={
        <SettingsSwitch
          checked={enabled}
          ariaLabelledBy="plugin-file-type-suggestions-label"
          onChange={() => void updateSettings({ pluginFileTypeSuggestions: !enabled })}
        />
      }
    />
  )
}
