import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import {
  DEFAULT_TERMINAL_FONT_WEIGHT_BOLD,
  TERMINAL_FONT_WEIGHT_MAX,
  TERMINAL_FONT_WEIGHT_MIN,
  TERMINAL_FONT_WEIGHT_STEP,
  normalizeTerminalFontWeight,
  normalizeTerminalFontWeightBold
} from '../../../../../../shared/terminal/appearance/terminal-fonts'
import {
  fontFamilyHasKnownLigatures,
  resolveTerminalLigaturesEnabled
} from '../../../../../../shared/terminal/appearance/terminal-ligatures'
import {
  NumberField,
  SettingsRow,
  SettingsSegmentedControl
} from '../../form-controls/SettingsFormControls'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { clampNumber } from '@/lib/terminal-theme'
import { useTranslate } from '@/i18n/use-translate'
import { defaultTerminalFontWeight } from '../../../../../../shared/terminal/appearance/terminal-platform-defaults'
import { isWindowsDesktopClient } from '@/lib/windows-path-access'
import { getTerminalAdvancedTypographySearchEntries } from './terminal-typography-search'

type TerminalAdvancedTypographyControlsProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

/** Keep rare typography controls searchable under Advanced without crowding the primary font controls. */
export function TerminalAdvancedTypographyControls({
  settings,
  updateSettings
}: TerminalAdvancedTypographyControlsProps): React.JSX.Element {
  const t = useTranslate()
  const searchEntries = getTerminalAdvancedTypographySearchEntries()

  return (
    <div className="divide-y divide-border/40">
      <SearchableSetting
        title={t('auto.components.settings.TerminalAppearanceSection.bb4ac88514', 'Font weight')}
        description={searchEntries[0]?.description}
        keywords={searchEntries[0]?.keywords ?? ['terminal', 'typography', 'weight']}
      >
        <NumberField
          label={t('auto.components.settings.TerminalAppearanceSection.bb4ac88514', 'Font weight')}
          description=""
          value={normalizeTerminalFontWeight(settings.terminalFontWeight)}
          defaultValue={defaultTerminalFontWeight(isWindowsDesktopClient() ? 'win32' : '')}
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
        title={t(
          'auto.components.settings.TerminalAdvancedTypographyControls.f40f6ef17c',
          'Bold font weight'
        )}
        description={t(
          'auto.components.settings.TerminalAdvancedTypographyControls.0e0d1ee15a',
          'Adjust independently from Font Weight. Some fonts map several values to one face, so lower Font Weight or choose another font if bold looks unchanged.'
        )}
        keywords={['terminal', 'typography', 'weight', 'bold']}
      >
        <NumberField
          label={t(
            'auto.components.settings.TerminalAdvancedTypographyControls.f40f6ef17c',
            'Bold font weight'
          )}
          description=""
          value={normalizeTerminalFontWeightBold(settings.terminalFontWeightBold)}
          defaultValue={DEFAULT_TERMINAL_FONT_WEIGHT_BOLD}
          min={TERMINAL_FONT_WEIGHT_MIN}
          max={TERMINAL_FONT_WEIGHT_MAX}
          step={TERMINAL_FONT_WEIGHT_STEP}
          suffix="100-900"
          onChange={(value) =>
            updateSettings({ terminalFontWeightBold: normalizeTerminalFontWeightBold(value) })
          }
        />
      </SearchableSetting>

      <SearchableSetting
        title={t('auto.components.settings.TerminalAppearanceSection.d9c0df9673', 'Line height')}
        description={searchEntries[1]?.description}
        keywords={
          searchEntries[1]?.keywords ?? ['terminal', 'typography', 'line height', 'spacing']
        }
      >
        <NumberField
          label={t('auto.components.settings.TerminalAppearanceSection.d9c0df9673', 'Line height')}
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
        title={t('auto.components.settings.TerminalAppearanceSection.e4cccb139e', 'Font ligatures')}
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
          label={t(
            'auto.components.settings.TerminalAppearanceSection.e4cccb139e',
            'Font ligatures'
          )}
          // Explain whether Auto enables ligatures for the current font.
          description={
            settings.terminalLigatures === 'on'
              ? t(
                  'auto.components.settings.TerminalAppearanceSection.7234abcd08',
                  'Always on. Fonts without ligatures simply render as-is.'
                )
              : settings.terminalLigatures === 'off'
                ? t(
                    'auto.components.settings.TerminalAppearanceSection.04569feb07',
                    'Always off, even for fonts that ship them.'
                  )
                : fontFamilyHasKnownLigatures(settings.terminalFontFamily)
                  ? t(
                      'auto.components.settings.TerminalAppearanceSection.400e950ca5',
                      'Auto - enabled for "{{value0}}".',
                      { value0: settings.terminalFontFamily }
                    )
                  : t(
                      'auto.components.settings.TerminalAppearanceSection.4b1f29598e',
                      'Auto - disabled for "{{value0}}".',
                      { value0: settings.terminalFontFamily || 'the current font' }
                    )
          }
          control={
            <SettingsSegmentedControl
              ariaLabel={t(
                'auto.components.settings.TerminalAppearanceSection.e4cccb139e',
                'Font ligatures'
              )}
              value={settings.terminalLigatures ?? 'auto'}
              onChange={(option) => updateSettings({ terminalLigatures: option })}
              options={[
                {
                  value: 'auto',
                  label: t('auto.components.settings.TerminalAppearanceSection.bc9ff84d61', 'Auto')
                },
                {
                  value: 'on',
                  label: t('auto.components.settings.TerminalAppearanceSection.84bd22f2cd', 'On')
                },
                {
                  value: 'off',
                  label: t('auto.components.settings.TerminalAppearanceSection.870377082f', 'Off')
                }
              ]}
            />
          }
        />
        <p className="sr-only" aria-live="polite">
          {t(
            'auto.components.settings.TerminalAppearanceSection.31f6e61085',
            'Ligatures are currently'
          )}{' '}
          {resolveTerminalLigaturesEnabled(settings.terminalLigatures, settings.terminalFontFamily)
            ? t('auto.components.settings.TerminalAppearanceSection.4e7d41a9f0', 'enabled')
            : t('auto.components.settings.TerminalAppearanceSection.4415beb958', 'disabled')}
          .
        </p>
      </SearchableSetting>
    </div>
  )
}
