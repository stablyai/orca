import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import { translateSearchKeyword } from './settings-search-keywords'

export function getInsertFinalNewlineSearchEntry() {
  return {
    title: translate('settings.editorInsertFinalNewline.title', 'Insert Final Newline'),
    description: translate(
      'settings.editorInsertFinalNewline.description',
      'Add a line break when saving a non-empty code file that does not end with one. Off by default.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.editorInsertFinalNewline.keywordNewline', 'newline', {
        aliases: ['final newline', 'trailing newline']
      }),
      ...translateSearchKeyword(
        'settings.editorInsertFinalNewline.keywordEndOfFile',
        'end of file',
        { aliases: ['eof', 'save'] }
      )
    ]
  }
}

export function EditorInsertFinalNewlineSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const entry = getInsertFinalNewlineSearchEntry()
  return (
    <SearchableSetting {...entry}>
      <SettingsSwitchRow
        label={entry.title}
        description={entry.description}
        checked={settings.editorInsertFinalNewline === true}
        onChange={() =>
          updateSettings({ editorInsertFinalNewline: !settings.editorInsertFinalNewline })
        }
      />
    </SearchableSetting>
  )
}
