import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  NumberField,
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader
} from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import {
  DARK_BG_MIN_CONTRAST,
  LIGHT_BG_MIN_CONTRAST,
  MAX_TERMINAL_CONTRAST_RATIO,
  MIN_TERMINAL_CONTRAST_RATIO,
  normalizeTerminalMinimumContrastRatio
} from '@/lib/terminal-contrast-correction'
import { translate } from '@/i18n/i18n'

// Why spell out the automatic pair: the effective floor depends on the composed pane background, so
// the row can only describe the rule, not a single number.
function describeMinimumContrastRatio(value: number | undefined): string {
  if (value === undefined) {
    return translate(
      'auto.components.settings.TerminalPane.minimumContrast.automatic',
      'Automatic: {{light}} on light backgrounds, {{dark}} on dark.',
      { light: LIGHT_BG_MIN_CONTRAST, dark: DARK_BG_MIN_CONTRAST }
    )
  }
  if (value === MIN_TERMINAL_CONTRAST_RATIO) {
    return translate(
      'auto.components.settings.TerminalPane.minimumContrast.disabled',
      'Correction off. Programs that rely on low contrast, like Powerline separators, render as sent.'
    )
  }
  return translate(
    'auto.components.settings.TerminalPane.minimumContrast.pinned',
    'Foreground colors are lifted until they reach {{ratio}}:1 against the background.',
    { ratio: value }
  )
}

type TerminalRenderingSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalRenderingSection({
  settings,
  updateSettings
}: TerminalRenderingSectionProps): React.JSX.Element {
  const effectiveMinimumContrastRatio = normalizeTerminalMinimumContrastRatio(
    settings.terminalMinimumContrastRatio
  )

  return (
    <section key="rendering" className="space-y-3">
      <SettingsSubsectionHeader
        title={translate('auto.components.settings.TerminalPane.2fba319f21', 'Rendering')}
        description={translate(
          'auto.components.settings.TerminalPane.72bc9334a0',
          'Terminal renderer behavior for live panes and new panes.'
        )}
      />

      <div className="divide-y divide-border/40">
        <SearchableSetting
          title={translate('auto.components.settings.TerminalPane.c1fc9e9444', 'GPU Acceleration')}
          description={translate(
            'auto.components.settings.TerminalPane.f07dfb4466',
            'Controls whether the terminal uses xterm.js WebGL rendering. Auto tries WebGL when the renderer is supported, with a conservative Linux fallback for software or unknown GPU renderers.'
          )}
          keywords={[
            'terminal',
            'gpu',
            'acceleration',
            'webgl',
            'renderer',
            'rendering',
            'graphics',
            'linux'
          ]}
        >
          <SettingsRow
            label={translate(
              'auto.components.settings.TerminalPane.c1fc9e9444',
              'GPU Acceleration'
            )}
            description={
              settings.terminalGpuAcceleration === 'off'
                ? translate(
                    'auto.components.settings.TerminalPane.fe4acf36c6',
                    'WebGL disabled; DOM renderer for max compatibility.'
                  )
                : settings.terminalGpuAcceleration === 'on'
                  ? translate(
                      'auto.components.settings.TerminalPane.7eaccc1424',
                      'WebGL is always attempted for terminal panes.'
                    )
                  : translate(
                      'auto.components.settings.TerminalPane.e0996d141a',
                      'Auto tries WebGL, with DOM fallback for unsupported or risky renderers.'
                    )
            }
            control={
              <SettingsSegmentedControl
                ariaLabel={translate(
                  'auto.components.settings.TerminalPane.c1fc9e9444',
                  'GPU Acceleration'
                )}
                value={settings.terminalGpuAcceleration ?? 'auto'}
                onChange={(option) => updateSettings({ terminalGpuAcceleration: option })}
                options={[
                  {
                    value: 'auto',
                    label: translate('auto.components.settings.TerminalPane.43c2ff7b0e', 'Auto')
                  },
                  {
                    value: 'on',
                    label: translate('auto.components.settings.TerminalPane.9c0b1c1792', 'On')
                  },
                  {
                    value: 'off',
                    label: translate('auto.components.settings.TerminalPane.3fe1c5bfe0', 'Off')
                  }
                ]}
              />
            }
          />
        </SearchableSetting>

        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalPane.minimumContrast.title',
            'Minimum Contrast Ratio'
          )}
          description={translate(
            'auto.components.settings.TerminalPane.minimumContrast.description',
            'Lifts terminal foreground colors that sit too close to the background. Leave blank for automatic, or set 1 to render program colors exactly as sent.'
          )}
          keywords={[
            'terminal',
            'contrast',
            'minimum',
            'ratio',
            'readability',
            'accessibility',
            'wcag',
            'powerline',
            'statusline',
            'dim',
            'washed out',
            'colors'
          ]}
        >
          <NumberField
            label={translate(
              'auto.components.settings.TerminalPane.minimumContrast.title',
              'Minimum Contrast Ratio'
            )}
            description={describeMinimumContrastRatio(effectiveMinimumContrastRatio)}
            value={effectiveMinimumContrastRatio}
            min={MIN_TERMINAL_CONTRAST_RATIO}
            max={MAX_TERMINAL_CONTRAST_RATIO}
            step={0.5}
            placeholder={translate(
              'auto.components.settings.TerminalPane.minimumContrast.placeholder',
              'Auto'
            )}
            suffix={translate(
              'auto.components.settings.TerminalPane.minimumContrast.suffix',
              'blank = automatic, 1 = off'
            )}
            onChange={(value) => updateSettings({ terminalMinimumContrastRatio: value })}
            onClear={() => updateSettings({ terminalMinimumContrastRatio: undefined })}
          />
        </SearchableSetting>
      </div>
    </section>
  )
}
