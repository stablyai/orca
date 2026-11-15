import { DEFAULT_TERMINAL_INACTIVE_PANE_OPACITY } from '../../../../../../shared/constants'
import {
  NumberField,
  SettingsRow,
  SettingsSegmentedControl
} from '../../form-controls/SettingsFormControls'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsGroupSubsection } from '../../section-layout/SettingsGroup'
import { clampNumber, resolvePaneStyleOptions } from '@/lib/terminal/appearance/terminal-theme'
import { useTranslate } from '@/i18n/use-translate'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'

type TerminalPaneAppearanceSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalPaneAppearanceSection({
  settings,
  updateSettings
}: TerminalPaneAppearanceSectionProps): React.JSX.Element {
  const t = useTranslate()
  const paneStyleOptions = resolvePaneStyleOptions(settings)

  return (
    <SettingsGroupSubsection
      title={t('auto.components.settings.TerminalAppearanceSection.0f6515bf50', 'Terminal panes')}
    >
      <SearchableSetting
        title={t(
          'auto.components.settings.TerminalAppearanceSection.4d8b35c479',
          'Inactive pane opacity'
        )}
        description={t(
          'auto.components.settings.TerminalAppearanceSection.db632cb50e',
          'Opacity applied to panes that are not currently active.'
        )}
        keywords={['pane', 'opacity', 'dimming']}
      >
        <NumberField
          label={t(
            'auto.components.settings.TerminalAppearanceSection.4d8b35c479',
            'Inactive pane opacity'
          )}
          description={t(
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
        title={t(
          'auto.components.settings.TerminalAppearanceSection.835aad4f9d',
          'Divider thickness'
        )}
        description={t(
          'auto.components.settings.TerminalAppearanceSection.a14a427ae4',
          'Thickness of the pane divider line.'
        )}
        keywords={['pane', 'divider', 'thickness']}
      >
        <NumberField
          label={t(
            'auto.components.settings.TerminalAppearanceSection.835aad4f9d',
            'Divider thickness'
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
        title={t('components.settings.TerminalPaneAppearance.headerButtons', 'Pane header buttons')}
        description={t(
          'components.settings.TerminalPaneAppearance.headerButtonsDescription',
          "Show the active pane's chat, split, and close buttons whenever the pane is active, or only while the pointer is over them or one of them has keyboard focus."
        )}
        keywords={['pane', 'header', 'buttons', 'split', 'close', 'hover', 'hide']}
      >
        <SettingsRow
          label={t(
            'components.settings.TerminalPaneAppearance.headerButtons',
            'Pane header buttons'
          )}
          description={t(
            'components.settings.TerminalPaneAppearance.headerButtonsHelper',
            'Hover over the top-right corner of a pane to reveal hidden buttons.'
          )}
          control={
            <SettingsSegmentedControl
              ariaLabel={t(
                'components.settings.TerminalPaneAppearance.headerButtons',
                'Pane header buttons'
              )}
              value={settings.terminalPaneHeaderButtons === 'hover' ? 'hover' : 'always'}
              onChange={(option) => updateSettings({ terminalPaneHeaderButtons: option })}
              options={[
                {
                  value: 'always',
                  label: t(
                    'components.settings.TerminalPaneAppearance.headerButtonsAlways',
                    'When active or hovered'
                  )
                },
                {
                  value: 'hover',
                  label: t(
                    'components.settings.TerminalPaneAppearance.headerButtonsOnHover',
                    'On hover or keyboard focus'
                  )
                }
              ]}
            />
          }
        />
      </SearchableSetting>
    </SettingsGroupSubsection>
  )
}
