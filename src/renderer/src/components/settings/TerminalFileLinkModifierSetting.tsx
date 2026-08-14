import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'
import {
  getTerminalFileLinkModifierDescription,
  getTerminalFileLinkModifierTitle
} from './terminal-file-link-modifier-copy'

type TerminalFileLinkModifierSettingProps = {
  settings: Pick<GlobalSettings, 'terminalFileLinkModifierInverts'>
  isMac: boolean
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalFileLinkModifierSetting({
  settings,
  isMac,
  updateSettings
}: TerminalFileLinkModifierSettingProps): React.JSX.Element {
  const title = getTerminalFileLinkModifierTitle()
  const description = getTerminalFileLinkModifierDescription({ isMac })

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={[
        'terminal',
        'file',
        'link',
        'shift',
        'modifier',
        'invert',
        'swap',
        'default app',
        'finder',
        isMac ? 'cmd' : 'ctrl'
      ]}
    >
      <SettingsSwitchRow
        label={title}
        description={description}
        checked={settings.terminalFileLinkModifierInverts === true}
        onChange={() =>
          updateSettings({
            terminalFileLinkModifierInverts: settings.terminalFileLinkModifierInverts !== true
          })
        }
      />
    </SearchableSetting>
  )
}
