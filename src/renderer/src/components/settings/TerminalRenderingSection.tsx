import type { GlobalSettings } from '../../../../shared/global-settings-types'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { TerminalContrastSetting } from './TerminalContrastSetting'
import { translate } from '@/i18n/i18n'
import {
  normalizeTerminalInlineImageCacheMb,
  TERMINAL_INLINE_IMAGE_CACHE_MB_PRESETS
} from '../../../../shared/terminal-inline-image-cache-policy'
import { resolveTerminalInlineImagesEnabled } from '../../../../shared/terminal-inline-images-settings'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

type TerminalRenderingSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalRenderingSection({
  settings,
  updateSettings
}: TerminalRenderingSectionProps): React.JSX.Element {
  const inlineImagesEnabled = resolveTerminalInlineImagesEnabled(settings.terminalInlineImages)
  const inlineImageCacheMb = normalizeTerminalInlineImageCacheMb(
    settings.terminalInlineImageCacheMb
  )
  // A hand-edited value outside the presets still needs a matching option to display.
  const inlineImageCacheOptions: number[] = [...TERMINAL_INLINE_IMAGE_CACHE_MB_PRESETS]
  if (!inlineImageCacheOptions.includes(inlineImageCacheMb)) {
    inlineImageCacheOptions.push(inlineImageCacheMb)
    inlineImageCacheOptions.sort((x, y) => x - y)
  }
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

        <TerminalContrastSetting settings={settings} updateSettings={updateSettings} />

        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalRenderingSection.6d4c55bacc',
            'Inline Images'
          )}
          description={translate(
            'auto.components.settings.TerminalRenderingSection.fffab5890b',
            'Display images directly in the terminal using SIXEL, iTerm2 (IIP), and Kitty graphics protocols.'
          )}
          keywords={[
            'terminal',
            'image',
            'images',
            'inline',
            'sixel',
            'iterm',
            'iip',
            'kitty',
            'graphics',
            'picture'
          ]}
          className="py-2"
        >
          <SettingsSwitchRow
            label={translate(
              'auto.components.settings.TerminalRenderingSection.6d4c55bacc',
              'Inline Images'
            )}
            description={translate(
              'auto.components.settings.TerminalRenderingSection.fffab5890b',
              'Display images directly in the terminal using SIXEL, iTerm2 (IIP), and Kitty graphics protocols.'
            )}
            checked={resolveTerminalInlineImagesEnabled(settings.terminalInlineImages)}
            onChange={() =>
              updateSettings({
                terminalInlineImages: !resolveTerminalInlineImagesEnabled(
                  settings.terminalInlineImages
                )
              })
            }
          />
        </SearchableSetting>

        <SearchableSetting
          title={translate(
            'auto.components.settings.TerminalRenderingSection.0121d245a6',
            'Inline Image Cache'
          )}
          description={translate(
            'auto.components.settings.TerminalRenderingSection.2b7791ac60',
            'Decoded-image memory kept per pane. When full, older images in scrollback are replaced by a placeholder. Larger values use more memory when many large images are shown.'
          )}
          keywords={['terminal', 'image', 'images', 'inline', 'cache', 'memory', 'limit']}
          className="py-2"
        >
          <SettingsRow
            label={translate(
              'auto.components.settings.TerminalRenderingSection.0121d245a6',
              'Inline Image Cache'
            )}
            description={translate(
              'auto.components.settings.TerminalRenderingSection.2b7791ac60',
              'Decoded-image memory kept per pane. When full, older images in scrollback are replaced by a placeholder. Larger values use more memory when many large images are shown.'
            )}
            control={
              <Select
                value={String(inlineImageCacheMb)}
                disabled={!inlineImagesEnabled}
                onValueChange={(value) =>
                  updateSettings({
                    terminalInlineImageCacheMb: normalizeTerminalInlineImageCacheMb(Number(value))
                  })
                }
              >
                <SelectTrigger
                  size="sm"
                  className="h-7 w-[120px]"
                  aria-label={translate(
                    'auto.components.settings.TerminalRenderingSection.a8a3f239c1',
                    'Inline image cache size'
                  )}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {inlineImageCacheOptions.map((mb) => (
                    <SelectItem key={mb} value={String(mb)}>
                      {translate('auto.components.settings.VoicePane.91980ce124', '{{value0}} MB', {
                        value0: mb
                      })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </SearchableSetting>
      </div>
    </section>
  )
}
