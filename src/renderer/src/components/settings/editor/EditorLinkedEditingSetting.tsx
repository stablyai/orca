import { translateSearchKeyword } from '../search/settings-search-keywords'
import { GENERAL_SETTING_ANCHORS } from '../general/general-setting-anchors'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'

export function getLinkedEditingSearchEntry() {
  return {
    title: translate('settings.general.linkedEditingTitle', 'Linked editing'),
    description: translate(
      'settings.general.linkedEditingDescription',
      'Rename the matching JSX tag while you edit a tag name.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.general.linkedEditingKeywordTag', 'tag'),
      ...translateSearchKeyword('settings.general.linkedEditingKeywordRename', 'rename'),
      ...translateSearchKeyword('settings.general.linkedEditingKeywordJsx', 'jsx')
    ]
  }
}

export function EditorLinkedEditingSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const entry = getLinkedEditingSearchEntry()
  return (
    <SearchableSetting id={GENERAL_SETTING_ANCHORS.linkedEditing} {...entry}>
      <SettingsSwitchRow
        label={entry.title}
        description={entry.description}
        checked={settings.editorLinkedEditing}
        onChange={() => updateSettings({ editorLinkedEditing: !settings.editorLinkedEditing })}
      />
    </SearchableSetting>
  )
}
