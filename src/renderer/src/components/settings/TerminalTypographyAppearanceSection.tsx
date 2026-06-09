import type { Dispatch, SetStateAction } from 'react'
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
import { Button } from '../ui/button'
import {
  FontAutocomplete,
  NumberField,
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader
} from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { clampNumber } from '@/lib/terminal-theme'
import { TerminalSettingsPreview } from './TerminalSettingsPreview'
import { TerminalFontSizeSetting } from './TerminalFontSizeSetting'
import type { UseGhosttyImportReturn } from './useGhosttyImport'
import ghosttyIcon from '../../../../../resources/ghostty.svg'
import { translate } from '@/i18n/i18n'

type TerminalTypographyAppearanceSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  systemPrefersDark: boolean
  terminalFontSuggestions: string[]
  ghostty: UseGhosttyImportReturn
  previewFontFamily: string | null
  setPreviewFontFamily: Dispatch<SetStateAction<string | null>>
}

export function TerminalTypographyAppearanceSection({
  settings,
  updateSettings,
  systemPrefersDark,
  terminalFontSuggestions,
  ghostty,
  previewFontFamily,
  setPreviewFontFamily
}: TerminalTypographyAppearanceSectionProps): React.JSX.Element {
  return (
    <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <SettingsSubsectionHeader
            title={translate(
              'auto.components.settings.TerminalAppearanceSection.048aac8a64',
              'Terminal Typography'
            )}
            description={translate(
              'auto.components.settings.TerminalAppearanceSection.711e589f18',
              'Default terminal typography for new panes and live updates.'
            )}
          />
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void ghostty.handleClick()}
          >
            <img src={ghosttyIcon} alt="" aria-hidden="true" className="size-4" />
            {translate(
              'auto.components.settings.TerminalAppearanceSection.855a76343a',
              'Import from Ghostty'
            )}
          </Button>
        </div>

        <div className="divide-y divide-border/40">
          <TerminalFontSizeSetting settings={settings} updateSettings={updateSettings} />

          <SearchableSetting
            title={translate(
              'auto.components.settings.TerminalAppearanceSection.a408266e67',
              'Font Family'
            )}
            description={translate(
              'auto.components.settings.TerminalAppearanceSection.f04b17a50e',
              'Default terminal font family for new panes and live updates.'
            )}
            keywords={['terminal', 'typography', 'font']}
          >
            <SettingsRow
              alignTop
              label={translate(
                'auto.components.settings.TerminalAppearanceSection.a408266e67',
                'Font Family'
              )}
              description={translate(
                'auto.components.settings.TerminalAppearanceSection.f04b17a50e',
                'Default terminal font family for new panes and live updates.'
              )}
              control={
                <FontAutocomplete
                  value={settings.terminalFontFamily}
                  suggestions={terminalFontSuggestions}
                  onChange={(value) => updateSettings({ terminalFontFamily: value })}
                  onPreviewFontFamily={setPreviewFontFamily}
                />
              }
            />
          </SearchableSetting>

          <SearchableSetting
            title={translate(
              'auto.components.settings.TerminalAppearanceSection.4aae5db258',
              'Font Weight'
            )}
            description={translate(
              'auto.components.settings.TerminalAppearanceSection.36af8ad94c',
              'Controls the terminal text font weight.'
            )}
            keywords={['terminal', 'typography', 'weight']}
          >
            <NumberField
              label={translate(
                'auto.components.settings.TerminalAppearanceSection.4aae5db258',
                'Font Weight'
              )}
              description={translate(
                'auto.components.settings.TerminalAppearanceSection.36af8ad94c',
                'Controls the terminal text font weight.'
              )}
              value={normalizeTerminalFontWeight(settings.terminalFontWeight)}
              defaultValue={DEFAULT_TERMINAL_FONT_WEIGHT}
              min={TERMINAL_FONT_WEIGHT_MIN}
              max={TERMINAL_FONT_WEIGHT_MAX}
              step={TERMINAL_FONT_WEIGHT_STEP}
              suffix="100-900"
              onChange={(value) =>
                updateSettings({
                  terminalFontWeight: normalizeTerminalFontWeight(value)
                })
              }
            />
          </SearchableSetting>

          <SearchableSetting
            title={translate(
              'auto.components.settings.TerminalAppearanceSection.c084eb7d4c',
              'Line Height'
            )}
            description={translate(
              'auto.components.settings.TerminalAppearanceSection.bafc80efbc',
              'Controls the terminal line height multiplier.'
            )}
            keywords={['terminal', 'typography', 'line height', 'spacing']}
          >
            <NumberField
              label={translate(
                'auto.components.settings.TerminalAppearanceSection.c084eb7d4c',
                'Line Height'
              )}
              description={translate(
                'auto.components.settings.TerminalAppearanceSection.bafc80efbc',
                'Controls the terminal line height multiplier.'
              )}
              value={settings.terminalLineHeight}
              defaultValue={1}
              min={1}
              max={3}
              step={0.1}
              suffix="1-3"
              onChange={(value) =>
                updateSettings({
                  terminalLineHeight: clampNumber(value, 1, 3)
                })
              }
            />
          </SearchableSetting>

          <SearchableSetting
            title={translate(
              'auto.components.settings.TerminalAppearanceSection.be8da35e7f',
              'Font Ligatures'
            )}
            description={translate(
              'auto.components.settings.TerminalAppearanceSection.7233d594bf',
              'Render programming ligatures (e.g. =>, !=, ===) for fonts that ship them. "Auto" enables ligatures only for known ligature fonts (Fira Code, JetBrains Mono, Cascadia Code, Iosevka, etc.).'
            )}
            keywords={[
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
            ]}
          >
            <SettingsRow
              label={translate(
                'auto.components.settings.TerminalAppearanceSection.be8da35e7f',
                'Font Ligatures'
              )}
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
              {resolveTerminalLigaturesEnabled(
                settings.terminalLigatures,
                settings.terminalFontFamily
              )
                ? translate(
                    'auto.components.settings.TerminalAppearanceSection.4e7d41a9f0',
                    'enabled'
                  )
                : translate(
                    'auto.components.settings.TerminalAppearanceSection.4415beb958',
                    'disabled'
                  )}
              .
            </p>
          </SearchableSetting>
        </div>
      </div>
      <TerminalSettingsPreview
        title={translate(
          'auto.components.settings.TerminalAppearanceSection.70beb1bbc7',
          'Preview'
        )}
        settings={settings}
        systemPrefersDark={systemPrefersDark}
        previewFontFamily={previewFontFamily}
        showThemeToggle
      />
    </section>
  )
}
