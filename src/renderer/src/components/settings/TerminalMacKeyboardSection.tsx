import type { GlobalSettings } from '../../../../shared/types'
import { useDetectedOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { SettingsRow, SettingsSegmentedControl, SettingsSwitchRow } from './SettingsFormControls'

type TerminalMacKeyboardSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalMacKeyboardSection({
  settings,
  updateSettings
}: TerminalMacKeyboardSectionProps): React.JSX.Element {
  const detectedLayout = useDetectedOptionAsAlt()
  const detectedLayoutLabel =
    detectedLayout === 'us'
      ? 'US English — Option sends Alt/Esc sequences'
      : detectedLayout === 'non-us'
        ? 'non-US layout — Option composes characters like @, €, [, ]'
        : 'unknown layout — Option composes characters (safe default)'

  return (
    <>
      <SearchableSetting
        title={translate('auto.components.settings.TerminalPane.0a10420e1a', 'Option as Alt')}
        description={translate(
          'auto.components.settings.TerminalPane.2561d3fc1b',
          'Controls whether the macOS Option key sends Alt/Esc sequences or composes characters.'
        )}
        keywords={[
          'terminal',
          'option',
          'alt',
          'key',
          'meta',
          'compose',
          'mac',
          'macos',
          'keyboard',
          'german',
          'international',
          'readline',
          'ghostty'
        ]}
      >
        <SettingsRow
          alignTop
          label={translate('auto.components.settings.TerminalPane.0a10420e1a', 'Option as Alt')}
          description={
            settings.terminalMacOptionAsAlt === 'auto'
              ? translate(
                  'auto.components.settings.TerminalPane.d21c493808',
                  'Auto — detected: {{value0}}.',
                  {
                    value0: detectedLayoutLabel
                  }
                )
              : settings.terminalMacOptionAsAlt === 'false'
                ? translate(
                    'auto.components.settings.TerminalPane.d8998bb328',
                    'Option composes special characters for your keyboard layout.'
                  )
                : settings.terminalMacOptionAsAlt === 'true'
                  ? translate(
                      'auto.components.settings.TerminalPane.b62373091a',
                      'Both Option keys send Alt/Esc sequences.'
                    )
                  : translate(
                      'auto.components.settings.TerminalPane.ce3aadf0b2',
                      'The {{value0}} Option key sends Alt/Esc; the other composes special characters.',
                      { value0: settings.terminalMacOptionAsAlt }
                    )
          }
          control={
            <SettingsSegmentedControl
              ariaLabel={translate(
                'auto.components.settings.TerminalPane.0a10420e1a',
                'Option as Alt'
              )}
              value={settings.terminalMacOptionAsAlt}
              onChange={(option) => updateSettings({ terminalMacOptionAsAlt: option })}
              options={[
                {
                  value: 'auto',
                  label: translate('auto.components.settings.TerminalPane.43c2ff7b0e', 'Auto')
                },
                {
                  value: 'true',
                  label: translate('auto.components.settings.TerminalPane.badb1219fc', 'Both')
                },
                {
                  value: 'left',
                  label: translate('auto.components.settings.TerminalPane.e7aec1fd60', 'Left')
                },
                {
                  value: 'right',
                  label: translate('auto.components.settings.TerminalPane.c73d510938', 'Right')
                },
                {
                  value: 'false',
                  label: translate('auto.components.settings.TerminalPane.3fe1c5bfe0', 'Off')
                }
              ]}
            />
          }
        />
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.TerminalPane.19f4935159',
          'JIS Yen (¥) to Backslash (\\\\)'
        )}
        description={translate(
          'auto.components.settings.TerminalPane.1c337bef4a',
          'Controls whether pressing the JIS Yen (¥) key sends a backslash (\\\\) instead.'
        )}
        keywords={[
          'terminal',
          'yen',
          'backslash',
          'japanese',
          'keyboard',
          'mac',
          'macos',
          'jis',
          'intl'
        ]}
      >
        <SettingsSwitchRow
          label={translate(
            'auto.components.settings.TerminalPane.19f4935159',
            'JIS Yen (¥) to Backslash (\\\\)'
          )}
          description={translate(
            'auto.components.settings.TerminalPane.4263e940e0',
            'Pressing the JIS Yen (¥) key sends a backslash (\\\\) instead.'
          )}
          checked={settings.terminalJISYenToBackslash ?? false}
          onChange={() =>
            updateSettings({
              terminalJISYenToBackslash: !settings.terminalJISYenToBackslash
            })
          }
        />
      </SearchableSetting>
    </>
  )
}
