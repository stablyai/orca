import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type BrowserLocalhostWorktreeLabelsSettingProps = {
  settings: Pick<GlobalSettings, 'localhostWorktreeLabelsEnabled'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BrowserLocalhostWorktreeLabelsSetting({
  settings,
  updateSettings
}: BrowserLocalhostWorktreeLabelsSettingProps): React.JSX.Element {
  const title = translate(
    'auto.components.settings.BrowserLocalhostWorktreeLabelsSetting.8ac8c3ad19',
    'Localhost Worktree Labels'
  )
  const description = translate(
    'auto.components.settings.BrowserLocalhostWorktreeLabelsSetting.1db3c8b983',
    'Open workspace ports as worktree-specific Orca localhost URLs so browser tabs are easier to tell apart.'
  )

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['browser', 'localhost', 'ports', 'worktree', 'tabs', 'favicon', 'labels']}
    >
      <SettingsSwitchRow
        label={title}
        description={description}
        checked={settings.localhostWorktreeLabelsEnabled === true}
        onChange={() =>
          updateSettings({
            localhostWorktreeLabelsEnabled: settings.localhostWorktreeLabelsEnabled !== true
          })
        }
      />
    </SearchableSetting>
  )
}
