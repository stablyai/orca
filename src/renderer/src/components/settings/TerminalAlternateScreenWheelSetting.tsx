import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSwitchRow } from './SettingsFormControls'

type TerminalAlternateScreenWheelSettingProps = {
  settings: Pick<GlobalSettings, 'terminalAlternateScreenWheelSendsArrowKeys'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalAlternateScreenWheelSetting({
  settings,
  updateSettings
}: TerminalAlternateScreenWheelSettingProps): React.JSX.Element {
  const title = translate(
    'auto.components.settings.TerminalAlternateScreenWheelSetting.title',
    'Full-screen apps: wheel sends arrow keys'
  )
  const description = translate(
    'auto.components.settings.TerminalAlternateScreenWheelSetting.description',
    'Scrolls pagers and editors that do not handle the mouse themselves. Turn off if scrolling a full-screen agent walks its prompt history instead. Apps that state their own preference are unaffected.'
  )

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={[
        'terminal',
        'wheel',
        'scroll',
        'arrow keys',
        'alternate screen',
        'full screen',
        'tui',
        'prompt history'
      ]}
    >
      <SettingsSwitchRow
        label={title}
        description={description}
        checked={settings.terminalAlternateScreenWheelSendsArrowKeys}
        onChange={() =>
          updateSettings({
            terminalAlternateScreenWheelSendsArrowKeys:
              !settings.terminalAlternateScreenWheelSendsArrowKeys
          })
        }
      />
    </SearchableSetting>
  )
}
