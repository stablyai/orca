import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { DEFAULT_TERMINAL_INACTIVE_PANE_OPACITY } from '../../../../shared/constants'
import {
  ColorField,
  NumberField,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { clampNumber, resolvePaneStyleOptions } from '@/lib/terminal-theme'
import { translate } from '@/i18n/i18n'

type TerminalPaneAppearanceSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalPaneAppearanceSection({
  settings,
  updateSettings
}: TerminalPaneAppearanceSectionProps): React.JSX.Element {
  const paneStyleOptions = resolvePaneStyleOptions(settings)
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.TerminalAppearanceSection.e1a5c25555',
          'Terminal Panes'
        )}
      />

      <div className="ml-4 divide-y divide-border/40">
        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalAppearanceSection.a6fdd6a3b1',
            'Inactive Pane Opacity'
          )}
          description={translate(
            'auto.components.settings.TerminalAppearanceSection.db632cb50e',
            'Opacity applied to panes that are not currently active.'
          )}
          keywords={['pane', 'opacity', 'dimming']}
        >
          <NumberField
            label={translate(
              'auto.components.settings.TerminalAppearanceSection.a6fdd6a3b1',
              'Inactive Pane Opacity'
            )}
            // Why: clarify which panes get dimmed; tightened per the copy audit.
            description={translate(
              'auto.components.settings.TerminalAppearanceSection.dimUnfocusedPanes',
              'Dim unfocused panes.'
            )}
            value={paneStyleOptions.inactivePaneOpacity}
            defaultValue={DEFAULT_TERMINAL_INACTIVE_PANE_OPACITY}
            min={0}
            max={1}
            step={0.05}
            suffix="0-1"
            onChange={(value) =>
              updateSettings({
                terminalInactivePaneOpacity: clampNumber(value, 0, 1)
              })
            }
          />
        </SearchableSetting>
        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalAppearanceSection.f27a99978d',
            'Divider Thickness'
          )}
          description={translate(
            'auto.components.settings.TerminalAppearanceSection.a14a427ae4',
            'Thickness of the pane divider line.'
          )}
          keywords={['pane', 'divider', 'thickness']}
        >
          <NumberField
            label={translate(
              'auto.components.settings.TerminalAppearanceSection.f27a99978d',
              'Divider Thickness'
            )}
            description=""
            value={paneStyleOptions.dividerThicknessPx}
            defaultValue={1}
            min={1}
            max={32}
            step={1}
            suffix="px"
            onChange={(value) =>
              updateSettings({
                terminalDividerThicknessPx: clampNumber(value, 1, 32)
              })
            }
          />
        </SearchableSetting>
        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalAppearanceSection.activePaneBorder',
            'Active Pane Border'
          )}
          description={translate(
            'auto.components.settings.TerminalAppearanceSection.activePaneBorderDesc',
            'Outline the focused pane. Matches the divider thickness above.'
          )}
          keywords={['pane', 'border', 'outline', 'active', 'focus', 'highlight']}
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.TerminalAppearanceSection.activePaneBorder',
              'Active Pane Border'
            )}
            description={translate(
              'auto.components.settings.TerminalAppearanceSection.activePaneBorderDesc',
              'Outline the focused pane. Matches the divider thickness above.'
            )}
            checked={paneStyleOptions.activePaneBorderEnabled}
            onChange={() =>
              updateSettings({
                terminalActivePaneBorderEnabled: !paneStyleOptions.activePaneBorderEnabled
              })
            }
          />
        </SearchableSetting>
        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalAppearanceSection.activePaneBorderColor',
            'Active Pane Border Color'
          )}
          description={translate(
            'auto.components.settings.TerminalAppearanceSection.activePaneBorderColorDesc',
            'Color of the focused pane outline.'
          )}
          keywords={['pane', 'border', 'outline', 'color', 'active', 'focus', 'highlight']}
        >
          <ColorField
            label={translate(
              'auto.components.settings.TerminalAppearanceSection.activePaneBorderColor',
              'Active Pane Border Color'
            )}
            description=""
            value={settings.terminalActivePaneBorderColor ?? ''}
            fallback={document.documentElement.classList.contains('dark') ? '#60a5fa' : '#2563eb'}
            onChange={(value) => updateSettings({ terminalActivePaneBorderColor: value })}
          />
        </SearchableSetting>
      </div>
    </section>
  )
}
