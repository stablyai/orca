import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { DEFAULT_TERMINAL_INACTIVE_PANE_OPACITY } from '../../../../shared/constants'
import {
  NumberField,
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader
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
            'components.settings.TerminalPaneAppearance.headerButtons',
            'Pane Header Buttons'
          )}
          description={translate(
            'components.settings.TerminalPaneAppearance.headerButtonsDescription',
            "Show the active pane's chat, split, and close buttons whenever the pane is active, or only while the pointer is over them or one of them has keyboard focus."
          )}
          keywords={['pane', 'header', 'buttons', 'split', 'close', 'hover', 'hide']}
        >
          <SettingsRow
            label={translate(
              'components.settings.TerminalPaneAppearance.headerButtons',
              'Pane Header Buttons'
            )}
            description={translate(
              'components.settings.TerminalPaneAppearance.headerButtonsHelper',
              'Hover over the top-right corner of a pane to reveal hidden buttons.'
            )}
            control={
              <SettingsSegmentedControl
                ariaLabel={translate(
                  'components.settings.TerminalPaneAppearance.headerButtons',
                  'Pane Header Buttons'
                )}
                value={settings.terminalPaneHeaderButtons === 'hover' ? 'hover' : 'always'}
                onChange={(option) => updateSettings({ terminalPaneHeaderButtons: option })}
                options={[
                  {
                    value: 'always',
                    label: translate(
                      'components.settings.TerminalPaneAppearance.headerButtonsAlways',
                      'When active or hovered'
                    )
                  },
                  {
                    value: 'hover',
                    label: translate(
                      'components.settings.TerminalPaneAppearance.headerButtonsOnHover',
                      'On hover or keyboard focus'
                    )
                  }
                ]}
              />
            }
          />
        </SearchableSetting>
      </div>
    </section>
  )
}
