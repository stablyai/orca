import { GENERAL_SETTING_ANCHORS } from '../general/general-setting-anchors'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export function getBlameColumnSearchEntry(t: Translate = translate) {
  return {
    title: t('settings.general.blameColumnTitle', 'Git blame column'),
    description: t(
      'settings.general.blameColumnDescription',
      'Show who last changed each line, and when, beside the line numbers.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.general.inlineBlameKeywordBlame', 'blame', undefined, t),
      ...translateSearchKeyword('settings.general.inlineBlameKeywordGit', 'git', undefined, t),
      ...translateSearchKeyword(
        'settings.general.inlineBlameKeywordAuthor',
        'author',
        undefined,
        t
      ),
      ...translateSearchKeyword(
        'settings.general.blameColumnKeywordAnnotate',
        'annotate',
        undefined,
        t
      ),
      ...translateSearchKeyword('settings.general.blameColumnKeywordGutter', 'gutter', undefined, t)
    ]
  }
}

export function EditorBlameColumnSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const entry = getBlameColumnSearchEntry(t)
  return (
    <SearchableSetting id={GENERAL_SETTING_ANCHORS.blameColumn} {...entry}>
      <SettingsSwitchRow
        label={entry.title}
        description={entry.description}
        checked={settings.editorBlameColumn === true}
        onChange={() => updateSettings({ editorBlameColumn: settings.editorBlameColumn !== true })}
      />
    </SearchableSetting>
  )
}
