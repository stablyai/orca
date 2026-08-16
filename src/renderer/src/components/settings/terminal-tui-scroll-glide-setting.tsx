import type { GlobalSettings } from '../../../../shared/types'
import { SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { normalizeTerminalTuiScrollGlideIntensity } from '@/lib/pane-manager/pane-terminal-mouse-wheel'

type TerminalTuiScrollGlideSettingProps = {
  value: GlobalSettings['terminalTuiScrollGlide'] | undefined
  onChange: (value: GlobalSettings['terminalTuiScrollGlide']) => void
}

export function TerminalTuiScrollGlideSetting({
  value,
  onChange
}: TerminalTuiScrollGlideSettingProps): React.JSX.Element {
  const intensity = normalizeTerminalTuiScrollGlideIntensity(value)
  return (
    <SettingsRow
      label={translate(
        'auto.components.settings.TerminalPane.scrollSpeed.tuiGlide',
        'TUI scroll glide'
      )}
      description={translate(
        'auto.components.settings.TerminalPane.scrollSpeed.tuiGlideDescription',
        'Subtle paint lag while scrolling fullscreen apps (Claude, Codex, etc.). Visual only — does not change how the app scrolls.'
      )}
      control={
        <SettingsSegmentedControl
          ariaLabel={translate(
            'auto.components.settings.TerminalPane.scrollSpeed.tuiGlide',
            'TUI scroll glide'
          )}
          value={intensity}
          onChange={(option) => onChange(normalizeTerminalTuiScrollGlideIntensity(option))}
          options={[
            {
              value: 'off',
              label: translate(
                'auto.components.settings.TerminalPane.scrollSpeed.tuiGlideOff',
                'Off'
              )
            },
            {
              value: 'subtle',
              label: translate(
                'auto.components.settings.TerminalPane.scrollSpeed.tuiGlideSubtle',
                'Subtle'
              )
            },
            {
              value: 'medium',
              label: translate(
                'auto.components.settings.TerminalPane.scrollSpeed.tuiGlideMedium',
                'Medium'
              )
            }
          ]}
        />
      }
    />
  )
}
