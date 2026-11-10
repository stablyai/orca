import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { DEFAULT_TERMINAL_INACTIVE_PANE_OPACITY } from '../../../../../../shared/constants'
import { NumberField, SettingsSubsectionHeader } from '../../form-controls/SettingsFormControls'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { clampNumber, resolvePaneStyleOptions } from '@/lib/terminal-theme'
import { useTranslate } from '@/i18n/use-translate'

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
    <section className="space-y-3">
      <SettingsSubsectionHeader
        title={t('auto.components.settings.TerminalAppearanceSection.0f6515bf50', 'Terminal panes')}
      />

      <div className="ml-4 divide-y divide-border/40">
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
      </div>
    </section>
  )
}
