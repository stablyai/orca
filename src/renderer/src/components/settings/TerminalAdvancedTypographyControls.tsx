import type { GlobalSettings } from '../../../../shared/types'
import {
  DEFAULT_TERMINAL_FONT_WEIGHT,
  TERMINAL_FONT_WEIGHT_MAX,
  TERMINAL_FONT_WEIGHT_MIN,
  TERMINAL_FONT_WEIGHT_STEP,
  normalizeTerminalFontWeight
} from '../../../../shared/terminal-fonts'
import {
  fontFamilyHasKnownLigatures,
  resolveTerminalLigaturesEnabled
} from '../../../../shared/terminal-ligatures'
import { NumberField, SettingsRow, SettingsSegmentedControl } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { clampNumber } from '@/lib/terminal-theme'
import { translate } from '@/i18n/i18n'
import { getTerminalAdvancedTypographySearchEntries } from './terminal-typography-search'

type TerminalAdvancedTypographyControlsProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/** Low-frequency terminal typography knobs (weight, line height, ligatures).
 *  Split out of the primary font controls so the default Terminal scan stays
 *  compact while these stay searchable inside the Advanced disclosure. */
export function TerminalAdvancedTypographyControls({
  settings,
  updateSettings
}: TerminalAdvancedTypographyControlsProps): React.JSX.Element {
  const searchEntries = getTerminalAdvancedTypographySearchEntries()

  return (
    <div className="divide-y divide-border/40">
      <SearchableSetting
        title={translate(
          'auto.components.settings.TerminalAppearanceSection.4aae5db258',
          'Font Weight'
        )}
        description={searchEntries[0]?.description}
        keywords={searchEntries[0]?.keywords ?? ['terminal', 'typography', 'weight']}
      >
        <NumberField
          label={translate(
            'auto.components.settings.TerminalAppearanceSection.4aae5db258',
            'Font Weight'
          )}
          description=""
          value={normalizeTerminalFontWeight(settings.terminalFontWeight)}
          defaultValue={DEFAULT_TERMINAL_FONT_WEIGHT}
          min={TERMINAL_FONT_WEIGHT_MIN}
          max={TERMINAL_FONT_WEIGHT_MAX}
          step={TERMINAL_FONT_WEIGHT_STEP}
          suffix="100-900"
          onChange={(value) =>
            updateSettings({ terminalFontWeight: normalizeTerminalFontWeight(value) })
          }
        />
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.TerminalAppearanceSection.c084eb7d4c',
          'Line Height'
        )}
        description={searchEntries[1]?.description}
        keywords={
          searchEntries[1]?.keywords ?? ['terminal', 'typography', 'line height', 'spacing']
        }
      >
        <NumberField
          label={translate(
            'auto.components.settings.TerminalAppearanceSection.c084eb7d4c',
            'Line Height'
          )}
          description=""
          value={settings.terminalLineHeight}
          defaultValue={1}
          min={1}
          max={3}
          step={0.1}
          suffix="1-3"
          onChange={(value) => updateSettings({ terminalLineHeight: clampNumber(value, 1, 3) })}
        />
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.TerminalAppearanceSection.be8da35e7f',
          'Font Ligatures'
        )}
        description={searchEntries[2]?.description}
        keywords={
          searchEntries[2]?.keywords ?? [
            'terminal',
            'typography',
            'ligatures',
            'ligature',
            'fira code',
            'jetbrains mono',
            'cascadia code',
            'iosevka',
            'calt',
            'font features'
          ]
        }
      >
        <SettingsRow
          label={translate(
            'auto.components.settings.TerminalAppearanceSection.be8da35e7f',
            'Font Ligatures'
          )}
          // Why: "ligatures" is jargon; the per-state gloss tells the user whether
          // Auto resolves on/off for their current font.
          description={
            settings.terminalLigatures === 'on'
              ? translate(
                  'auto.components.settings.TerminalAppearanceSection.7234abcd08',
                  'Always on. Fonts without ligatures simply render as-is.'
                )
              : settings.terminalLigatures === 'off'
                ? translate(
                    'auto.components.settings.TerminalAppearanceSection.04569feb07',
                    'Always off, even for fonts that ship them.'
                  )
                : fontFamilyHasKnownLigatures(settings.terminalFontFamily)
                  ? translate(
                      'auto.components.settings.TerminalAppearanceSection.400e950ca5',
                      'Auto - enabled for "{{value0}}".',
                      { value0: settings.terminalFontFamily }
                    )
                  : translate(
                      'auto.components.settings.TerminalAppearanceSection.4b1f29598e',
                      'Auto - disabled for "{{value0}}".',
                      { value0: settings.terminalFontFamily || 'the current font' }
                    )
          }
          control={
            <SettingsSegmentedControl
              ariaLabel={translate(
                'auto.components.settings.TerminalAppearanceSection.be8da35e7f',
                'Font Ligatures'
              )}
              value={settings.terminalLigatures ?? 'auto'}
              onChange={(option) => updateSettings({ terminalLigatures: option })}
              options={[
                {
                  value: 'auto',
                  label: translate(
                    'auto.components.settings.TerminalAppearanceSection.bc9ff84d61',
                    'Auto'
                  )
                },
                {
                  value: 'on',
                  label: translate(
                    'auto.components.settings.TerminalAppearanceSection.84bd22f2cd',
                    'On'
                  )
                },
                {
                  value: 'off',
                  label: translate(
                    'auto.components.settings.TerminalAppearanceSection.870377082f',
                    'Off'
                  )
                }
              ]}
            />
          }
        />
        <p className="sr-only" aria-live="polite">
          {translate(
            'auto.components.settings.TerminalAppearanceSection.31f6e61085',
            'Ligatures are currently'
          )}{' '}
          {resolveTerminalLigaturesEnabled(settings.terminalLigatures, settings.terminalFontFamily)
            ? translate('auto.components.settings.TerminalAppearanceSection.4e7d41a9f0', 'enabled')
            : translate(
                'auto.components.settings.TerminalAppearanceSection.4415beb958',
                'disabled'
              )}
          .
        </p>
      </SearchableSetting>
    </div>
  )
}
