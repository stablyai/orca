import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type InlineGitBlameSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/**
 * Editor setting controlling inline Git blame on the active Monaco line.
 */
export function InlineGitBlameSetting({
  settings,
  updateSettings
}: InlineGitBlameSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.InlineGitBlameSetting.b487a63c2b',
        'Inline Git Blame'
      )}
      description={translate(
        'auto.components.settings.InlineGitBlameSetting.3334d39de5',
        'Show the last commit that touched the active editor line.'
      )}
      keywords={['git', 'blame', 'history', 'inline', 'author', 'commit']}
    >
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.InlineGitBlameSetting.b487a63c2b',
          'Inline Git Blame'
        )}
        description={translate(
          'auto.components.settings.InlineGitBlameSetting.3334d39de5',
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
