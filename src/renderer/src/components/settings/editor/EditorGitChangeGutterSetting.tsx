import { GENERAL_SETTING_ANCHORS } from '../general/general-setting-anchors'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { translateSearchKeyword } from '../search/settings-search-keywords'

export function getGitChangeGutterSearchEntry(t: Translate = translate) {
  return {
    title: t('settings.editorGitChangeGutter.title', 'Git change indicators'),
    description: t(
      'settings.editorGitChangeGutter.description',
      'Mark added, modified, and deleted lines in the gutter, compared with the last commit. Off by default.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'settings.editorGitChangeGutter.keywordGit',
        'git',
        { aliases: ['diff', 'changes', 'modified'] },
        t
      ),
      ...translateSearchKeyword(
        'settings.editorGitChangeGutter.keywordGutter',
        'gutter',
        { aliases: ['indicators', 'markers', 'line numbers'] },
        t
      )
    ]
  }
}

export function EditorGitChangeGutterSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const entry = getGitChangeGutterSearchEntry(t)
  return (
    <SearchableSetting id={GENERAL_SETTING_ANCHORS.gitChangeGutter} {...entry}>
      <SettingsSwitchRow
        label={entry.title}
        description={entry.description}
        checked={settings.editorGitChangeGutterEnabled === true}
        onChange={() =>
          updateSettings({
            editorGitChangeGutterEnabled: settings.editorGitChangeGutterEnabled !== true
          })
        }
      />
    </SearchableSetting>
  )
}
