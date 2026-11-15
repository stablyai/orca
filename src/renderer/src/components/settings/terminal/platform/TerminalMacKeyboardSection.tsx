import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { useDetectedOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { TERMINAL_MAC_YEN_SETTING_ID } from './terminal-advanced-platform-search'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSwitchRow
} from '../../form-controls/SettingsFormControls'

type TerminalMacKeyboardSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalMacKeyboardSection({
  settings,
  updateSettings
}: TerminalMacKeyboardSectionProps): React.JSX.Element {
  const t = useTranslate()
  const detectedLayout = useDetectedOptionAsAlt()
  const detectedLayoutLabel =
    detectedLayout === 'us'
      ? t('settings.terminal.optionLayoutAlt', 'ABC or U.S. — Option sends Alt/Esc sequences')
      : detectedLayout === 'non-us'
        ? t(
            'settings.terminal.optionLayoutCompose',
            'layout uses Option to compose characters like @, €, [, ]'
          )
        : t(
            'settings.terminal.optionLayoutUnknown',
            'unknown layout — Option composes characters (safe default)'
          )

  return (
    <>
      <SearchableSetting
        title={t('auto.components.settings.TerminalPane.0a10420e1a', 'Option as Alt')}
        description={t(
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
          label={t('auto.components.settings.TerminalPane.0a10420e1a', 'Option as Alt')}
          description={
            <>
              {settings.terminalMacOptionAsAlt === 'auto'
                ? t(
                    'auto.components.settings.TerminalPane.d21c493808',
                    'Auto — detected: {{value0}}.',
                    {
                      value0: detectedLayoutLabel
                    }
                  )
                : settings.terminalMacOptionAsAlt === 'false'
                  ? t(
                      'auto.components.settings.TerminalPane.d8998bb328',
                      'Option composes special characters for your keyboard layout.'
                    )
                  : settings.terminalMacOptionAsAlt === 'true'
                    ? t(
                        'auto.components.settings.TerminalPane.b62373091a',
                        'Both Option keys send Alt/Esc sequences.'
                      )
                    : t(
                        'auto.components.settings.TerminalPane.ce3aadf0b2',
                        'The {{value0}} Option key sends Alt/Esc; the other composes special characters.',
                        { value0: settings.terminalMacOptionAsAlt }
                      )}{' '}
              {t(
                'settings.terminal.optionShortcutHint',
                'Choose Both for Option shortcuts, Off for accents and symbols, or Left/Right to use one Option key for each.'
              )}
            </>
          }
          control={
            <SettingsSegmentedControl
              ariaLabel={t('auto.components.settings.TerminalPane.0a10420e1a', 'Option as Alt')}
              value={settings.terminalMacOptionAsAlt}
              onChange={(option) => updateSettings({ terminalMacOptionAsAlt: option })}
              options={[
                {
                  value: 'auto',
                  label: t('auto.components.settings.TerminalPane.43c2ff7b0e', 'Auto')
                },
                {
                  value: 'true',
                  label: t('auto.components.settings.TerminalPane.badb1219fc', 'Both')
                },
                {
                  value: 'left',
                  label: t('auto.components.settings.TerminalPane.e7aec1fd60', 'Left')
                },
                {
                  value: 'right',
                  label: t('auto.components.settings.TerminalPane.c73d510938', 'Right')
                },
                {
                  value: 'false',
                  label: t('auto.components.settings.TerminalPane.3fe1c5bfe0', 'Off')
                }
              ]}
            />
          }
        />
      </SearchableSetting>

      <SearchableSetting
        id={TERMINAL_MAC_YEN_SETTING_ID}
        title={t(
          'auto.components.settings.TerminalPane.19f4935159',
          'JIS Yen (¥) to Backslash (\\\\)'
        )}
        description={t(
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
          label={t(
            'auto.components.settings.TerminalPane.19f4935159',
            'JIS Yen (¥) to Backslash (\\\\)'
          )}
          description={t(
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
