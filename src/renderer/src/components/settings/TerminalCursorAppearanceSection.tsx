import type { GlobalSettings } from '../../../../shared/types'
import {
  NumberField,
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { clampNumber } from '@/lib/terminal-theme'
import { translate } from '@/i18n/i18n'

type TerminalCursorAppearanceSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalCursorAppearanceSection({
  settings,
  updateSettings
}: TerminalCursorAppearanceSectionProps): React.JSX.Element {
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.TerminalAppearanceSection.abcb4dd019',
          'Terminal Cursor'
        )}
        description={translate(
          'auto.components.settings.TerminalAppearanceSection.d455f2ef4f',
          'Default cursor appearance for Orca terminal panes.'
        )}
      />

      <div className="divide-y divide-border/40">
        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalAppearanceSection.db270cc9a9',
            'Cursor Shape'
          )}
          description={translate(
            'auto.components.settings.TerminalAppearanceSection.d455f2ef4f',
            'Default cursor appearance for Orca terminal panes.'
          )}
          keywords={['terminal', 'cursor', 'bar', 'block', 'underline']}
        >
          <SettingsRow
            label={translate(
              'auto.components.settings.TerminalAppearanceSection.db270cc9a9',
              'Cursor Shape'
            )}
            description={translate(
              'auto.components.settings.TerminalAppearanceSection.d455f2ef4f',
              'Default cursor appearance for Orca terminal panes.'
            )}
            control={
              <SettingsSegmentedControl
                ariaLabel={translate(
                  'auto.components.settings.TerminalAppearanceSection.db270cc9a9',
                  'Cursor Shape'
                )}
                value={settings.terminalCursorStyle}
                onChange={(option) => updateSettings({ terminalCursorStyle: option })}
                options={[
                  {
                    value: 'bar',
                    label: translate(
                      'auto.components.settings.TerminalAppearanceSection.e070e8aeba',
                      'Bar'
                    )
                  },
                  {
                    value: 'block',
                    label: translate(
                      'auto.components.settings.TerminalAppearanceSection.52854a5608',
                      'Block'
                    )
                  },
                  {
                    value: 'underline',
                    label: translate(
                      'auto.components.settings.TerminalAppearanceSection.2e5aec3cf6',
                      'Underline'
                    )
                  }
                ]}
              />
            }
          />
        </SearchableSetting>

        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalAppearanceSection.74736cc9b1',
            'Blinking Cursor'
          )}
          description={translate(
            'auto.components.settings.TerminalAppearanceSection.2de6b5a699',
            'Uses the blinking variant of the selected cursor shape.'
          )}
          keywords={['terminal', 'cursor', 'blink']}
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.TerminalAppearanceSection.74736cc9b1',
              'Blinking Cursor'
            )}
            description={translate(
              'auto.components.settings.TerminalAppearanceSection.2de6b5a699',
              'Uses the blinking variant of the selected cursor shape.'
            )}
            checked={settings.terminalCursorBlink}
            onChange={() => updateSettings({ terminalCursorBlink: !settings.terminalCursorBlink })}
          />
        </SearchableSetting>

        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalAppearanceSection.b9f1804422',
            'Cursor Opacity'
          )}
          description={translate(
            'auto.components.settings.TerminalAppearanceSection.04cdf85dec',
            'Opacity of the terminal cursor.'
          )}
          keywords={['terminal', 'cursor', 'opacity', 'transparency']}
        >
          <NumberField
            label={translate(
              'auto.components.settings.TerminalAppearanceSection.b9f1804422',
              'Cursor Opacity'
            )}
            description={translate(
              'auto.components.settings.TerminalAppearanceSection.04cdf85dec',
              'Opacity of the terminal cursor.'
            )}
            value={settings.terminalCursorOpacity ?? 1}
            defaultValue={1}
            min={0}
            max={1}
            step={0.05}
            suffix="0-1"
            onChange={(value) =>
              updateSettings({
                terminalCursorOpacity: clampNumber(value, 0, 1)
              })
            }
          />
        </SearchableSetting>
      </div>
    </section>
  )
}
