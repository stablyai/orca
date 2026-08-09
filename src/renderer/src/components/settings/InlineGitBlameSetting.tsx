import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type InlineGitBlameSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function InlineGitBlameSetting({
  settings,
  updateSettings
}: InlineGitBlameSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.GeneralEditorSettingsSection.1c2a3b4c5d',
        'Inline Git Blame'
      )}
      description={translate(
        'auto.components.settings.GeneralEditorSettingsSection.2d3e4f5a6b',
        'Show the last commit that touched the active editor line.'
      )}
      keywords={['git', 'blame', 'history', 'inline', 'author', 'commit']}
    >
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.GeneralEditorSettingsSection.1c2a3b4c5d',
          'Inline Git Blame'
        )}
        description={translate(
          'auto.components.settings.GeneralEditorSettingsSection.2d3e4f5a6b',
          'Show the last commit that touched the active editor line.'
        )}
        checked={settings.enableInlineGitBlame !== false}
        onChange={() =>
          updateSettings({ enableInlineGitBlame: settings.enableInlineGitBlame === false })
        }
      />
    </SearchableSetting>
  )
}
