import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type EditorGitGutterSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function EditorGitGutterSetting({
  settings,
  updateSettings
}: EditorGitGutterSettingProps): React.JSX.Element {
  // Why: absent means on, so the toggle reads and writes against `!== false`, not the raw value.
  const enabled = settings.editorGitGutter !== false
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.EditorGitGutterSetting.0d6a6bc1e3',
        'Git Change Indicators'
      )}
      description={translate(
        'auto.components.settings.EditorGitGutterSetting.68bbcab1b6',
        'Show added, modified, and deleted line markers in the editor gutter, compared against the last commit.'
      )}
      keywords={['editor', 'git', 'gutter', 'diff', 'changes', 'indicators', 'vscode']}
    >
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.EditorGitGutterSetting.0d6a6bc1e3',
          'Git Change Indicators'
        )}
        description={translate(
          'auto.components.settings.EditorGitGutterSetting.68bbcab1b6',
          'Show added, modified, and deleted line markers in the editor gutter, compared against the last commit.'
        )}
        checked={enabled}
        onChange={() => updateSettings({ editorGitGutter: !enabled })}
      />
    </SearchableSetting>
  )
}
