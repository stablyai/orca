import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export function getInsertFinalNewlineSearchEntry(t: Translate = translate) {
  return {
    title: t('settings.editorInsertFinalNewline.title', 'Insert Final Newline'),
    description: t(
      'settings.editorInsertFinalNewline.description',
      'Add a line break when saving a non-empty code file that does not end with one. Off by default.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'settings.editorInsertFinalNewline.keywordNewline',
        'newline',
        {
          aliases: ['final newline', 'trailing newline']
        },
        t
      ),
      ...translateSearchKeyword(
        'settings.editorInsertFinalNewline.keywordEndOfFile',
        'end of file',
        { aliases: ['eof', 'save'] },
        t
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
  const t = useTranslate()
  const entry = getInsertFinalNewlineSearchEntry(t)
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
