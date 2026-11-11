import { GENERAL_SETTING_ANCHORS } from '../general/general-setting-anchors'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export function getJsonSchemasSearchEntry(t: Translate = translate) {
  return {
    title: t('settings.editor.remoteJsonSchemas', 'Download JSON Schemas'),
    description: t(
      'settings.editor.remoteJsonSchemasDescription',
      'Fetch schemas and known filename mappings from the web for JSON validation and completion. Turn off for offline use. Workspace schemas still work.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'settings.editor.remoteJsonSchemasKeywordSchema',
        'schema',
        { aliases: ['json', 'schemastore'] },
        t
      ),
      ...translateSearchKeyword(
        'settings.editor.remoteJsonSchemasKeywordValidation',
        'validation',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'settings.editor.remoteJsonSchemasKeywordOffline',
        'offline',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'settings.editor.remoteJsonSchemasKeywordPrivacy',
        'privacy',
        undefined,
        t
      )
    ]
  }
}

export function EditorJsonSchemasSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const entry = getJsonSchemasSearchEntry(t)
  const enabled = settings.editorRemoteJsonSchemas !== false
  return (
    <SearchableSetting id={GENERAL_SETTING_ANCHORS.jsonSchemas} {...entry}>
      <SettingsSwitchRow
        label={entry.title}
        description={entry.description}
        checked={enabled}
        onChange={() => updateSettings({ editorRemoteJsonSchemas: !enabled })}
      />
    </SearchableSetting>
  )
}
