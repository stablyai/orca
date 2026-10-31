import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

export function EditorJsonSchemasSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const enabled = settings.editorRemoteJsonSchemas !== false
  const title = translate('settings.editor.remoteJsonSchemas', 'Download JSON Schemas')
  const description = translate(
    'settings.editor.remoteJsonSchemasDescription',
    'Fetch schemas and known filename mappings from the web for JSON validation and completion. Turn off for offline use. Workspace schemas still work.'
  )
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['json', 'schema', 'validation', 'offline', 'privacy', 'schemastore']}
    >
      <SettingsSwitchRow
        label={title}
        description={description}
        checked={enabled}
        onChange={() => updateSettings({ editorRemoteJsonSchemas: !enabled })}
      />
    </SearchableSetting>
  )
}
