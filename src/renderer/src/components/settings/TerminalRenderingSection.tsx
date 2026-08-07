import type { GlobalSettings } from '../../../../shared/types'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader
} from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { translate } from '@/i18n/i18n'

type TerminalRenderingSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalRenderingSection({
  settings,
  updateSettings
}: TerminalRenderingSectionProps): React.JSX.Element {
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
            'auto.components.settings.TerminalPane.a1b2c3d4e5',
            'Font Smoothing'
          )}
          description={translate(
            'auto.components.settings.TerminalPane.b2c3d4e5f6',
            'Anti-aliasing for terminal glyphs. Subpixel matches VS Code on light themes; Default inherits the app-wide grayscale smoothing.'
          )}
          keywords={[
            'terminal',
            'font',
            'smoothing',
            'antialiasing',
            'antialiased',
            'subpixel',
            'rendering',
            'glyph'
          ]}
        >
          <SettingsRow
            label={translate('auto.components.settings.TerminalPane.c3d4e5f6a7', 'Font Smoothing')}
            description={
              settings.terminalFontSmoothing === 'subpixel'
                ? translate(
                    'auto.components.settings.TerminalPane.d4e5f6a7b8',
                    'macOS subpixel smoothing; sharper on light themes, like VS Code.'
                  )
                : settings.terminalFontSmoothing === 'antialiased'
                  ? translate(
                      'auto.components.settings.TerminalPane.e5f6a7b8c9',
                      'Grayscale smoothing, pinned explicitly.'
                    )
                  : translate(
                      'auto.components.settings.TerminalPane.f6a7b8c9d0',
                      'Inherit the app-wide grayscale smoothing (default).'
                    )
            }
            control={
              <SettingsSegmentedControl
                ariaLabel={translate(
                  'auto.components.settings.TerminalPane.c3d4e5f6a7',
                  'Font Smoothing'
                )}
                value={settings.terminalFontSmoothing ?? 'default'}
                onChange={(option) => updateSettings({ terminalFontSmoothing: option })}
                options={[
                  {
                    value: 'default',
                    label: translate(
                      'auto.components.settings.TerminalPane.a7b8c9d0e1',
                      'Default'
                    )
                  },
                  {
                    value: 'antialiased',
                    label: translate(
                      'auto.components.settings.TerminalPane.b8c9d0e1f2',
                      'Antialiased'
                    )
                  },
                  {
                    value: 'subpixel',
                    label: translate(
                      'auto.components.settings.TerminalPane.c9d0e1f2a3',
                      'Subpixel'
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
