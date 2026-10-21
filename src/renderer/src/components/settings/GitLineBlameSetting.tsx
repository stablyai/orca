import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type GitLineBlameSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function GitLineBlameSetting({
  settings,
  updateSettings
}: GitLineBlameSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.GeneralEditorSettingsSection.gitLineBlame',
        'Git Line Blame'
      )}
      description={translate(
        'auto.components.settings.GeneralEditorSettingsSection.gitLineBlameDesc',
        'Show who last changed the current line. Click the annotation to open that commit’s diff.'
      )}
      keywords={['git', 'blame', 'gitlens', 'author', 'commit']}
    >
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.GeneralEditorSettingsSection.gitLineBlame',
          'Git Line Blame'
        )}
        description={translate(
          'auto.components.settings.GeneralEditorSettingsSection.gitLineBlameDesc',
          'Show who last changed the current line. Click the annotation to open that commit’s diff.'
        )}
        checked={settings.editorGitLineBlameEnabled !== false}
        onChange={() =>
          updateSettings({
            editorGitLineBlameEnabled: settings.editorGitLineBlameEnabled === false
          })
        }
      />
    </SearchableSetting>
  )
}
