import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SettingsSwitchRow } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { isMacPlatform } from '../terminal-pane/terminal-link-open-hints'
import { translate } from '@/i18n/i18n'

export function TerminalMouseInputGateSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const isMac = isMacPlatform()
  const label = isMac
    ? translate(
        'auto.components.settings.TerminalInteractionSection.require_option_for_mouse_input',
        'Require Option for Mouse Input'
      )
    : translate(
        'auto.components.settings.TerminalInteractionSection.require_alt_for_mouse_input',
        'Require Alt for Mouse Input'
      )
  const description = isMac
    ? translate(
        'auto.components.settings.TerminalInteractionSection.require_alt_for_mouse_input_description_mac',
        'Clicks and drags reach a program that tracks the mouse only while Option is held, so a stray click cannot answer its prompt. Without Option they drive text selection instead, replacing the usual Option-drag to select. Scrolling is unchanged.'
      )
    : translate(
        'auto.components.settings.TerminalInteractionSection.require_alt_for_mouse_input_description',
        'Clicks and drags reach a program that tracks the mouse only while Alt is held, so a stray click cannot answer its prompt. Without Alt they drive text selection instead. Scrolling is unchanged.'
      )

  return (
    <SearchableSetting
      title={label}
      description={description}
      keywords={['mouse', 'click', 'alt', 'option', 'tui', 'prompt', 'selection']}
    >
      <SettingsSwitchRow
        label={label}
        description={description}
        checked={settings.terminalMouseEventsRequireAlt === true}
        onChange={() =>
          updateSettings({
            terminalMouseEventsRequireAlt: settings.terminalMouseEventsRequireAlt !== true
          })
        }
      />
    </SearchableSetting>
  )
}
