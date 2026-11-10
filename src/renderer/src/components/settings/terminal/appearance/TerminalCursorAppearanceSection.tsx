import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import {
  NumberField,
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from '../../form-controls/SettingsFormControls'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { clampNumber } from '@/lib/terminal-theme'
import { useTranslate } from '@/i18n/use-translate'

type TerminalCursorAppearanceSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalCursorAppearanceSection({
  settings,
  updateSettings
}: TerminalCursorAppearanceSectionProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={t(
          'auto.components.settings.TerminalAppearanceSection.abcb4dd019',
          'Terminal Cursor'
        )}
      />

      <div className="ml-4 divide-y divide-border/40">
        <SearchableSetting
          title={t('auto.components.settings.TerminalAppearanceSection.4adb9364f4', 'Cursor shape')}
          description={t(
            'auto.components.settings.TerminalAppearanceSection.d455f2ef4f',
            'Default cursor appearance for Orca terminal panes.'
          )}
          keywords={['terminal', 'cursor', 'bar', 'block', 'underline']}
        >
          <SettingsRow
            label={t(
              'auto.components.settings.TerminalAppearanceSection.4adb9364f4',
              'Cursor shape'
            )}
            control={
              <SettingsSegmentedControl
                ariaLabel={t(
                  'auto.components.settings.TerminalAppearanceSection.4adb9364f4',
                  'Cursor shape'
                )}
                value={settings.terminalCursorStyle}
                onChange={(option) => updateSettings({ terminalCursorStyle: option })}
                options={[
                  {
                    value: 'bar',
                    label: t('auto.components.settings.TerminalAppearanceSection.e070e8aeba', 'Bar')
                  },
                  {
                    value: 'block',
                    label: t(
                      'auto.components.settings.TerminalAppearanceSection.52854a5608',
                      'Block'
                    )
                  },
                  {
                    value: 'underline',
                    label: t(
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
          title={t(
            'auto.components.settings.TerminalAppearanceSection.74736cc9b1',
            'Blinking Cursor'
          )}
          description={t(
            'auto.components.settings.TerminalAppearanceSection.2de6b5a699',
            'Uses the blinking variant of the selected cursor shape.'
          )}
          keywords={['terminal', 'cursor', 'blink']}
        >
          <SettingsSwitchRow
            label={t(
              'auto.components.settings.TerminalAppearanceSection.74736cc9b1',
              'Blinking Cursor'
            )}
            checked={settings.terminalCursorBlink}
            onChange={() => updateSettings({ terminalCursorBlink: !settings.terminalCursorBlink })}
          />
        </SearchableSetting>

        <SearchableSetting
          title={t(
            'auto.components.settings.TerminalAppearanceSection.55c3f22e7c',
            'Cursor opacity'
          )}
          description={t(
            'auto.components.settings.TerminalAppearanceSection.04cdf85dec',
            'Opacity of the terminal cursor.'
          )}
          keywords={['terminal', 'cursor', 'opacity', 'transparency']}
        >
          <NumberField
            label={t(
              'auto.components.settings.TerminalAppearanceSection.55c3f22e7c',
              'Cursor opacity'
            )}
            description=""
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
