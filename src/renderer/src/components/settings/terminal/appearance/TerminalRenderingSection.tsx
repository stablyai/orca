import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import {
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSwitchRow
} from '../../form-controls/SettingsFormControls'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { TerminalContrastSetting } from './TerminalContrastSetting'
import { useTranslate } from '@/i18n/use-translate'
import { resolveTerminalInlineImagesEnabled } from '../../../../../../shared/terminal/images/terminal-inline-images-settings'
import { SettingsGroup } from '../../section-layout/SettingsGroup'

type TerminalRenderingSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalRenderingSection({
  settings,
  updateSettings
}: TerminalRenderingSectionProps): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsGroup
      key="rendering"
      title={t('auto.components.settings.TerminalPane.2fba319f21', 'Rendering')}
      description={t(
        'auto.components.settings.TerminalPane.72bc9334a0',
        'Terminal renderer behavior for live panes and new panes.'
      )}
    >
      <SearchableSetting
        title={t('auto.components.settings.TerminalPane.c1fc9e9444', 'GPU Acceleration')}
        description={t(
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
          label={t('auto.components.settings.TerminalPane.c1fc9e9444', 'GPU Acceleration')}
          description={
            settings.terminalGpuAcceleration === 'off'
              ? t(
                  'auto.components.settings.TerminalPane.fe4acf36c6',
                  'WebGL disabled; DOM renderer for max compatibility.'
                )
              : settings.terminalGpuAcceleration === 'on'
                ? t(
                    'auto.components.settings.TerminalPane.7eaccc1424',
                    'WebGL is always attempted for terminal panes.'
                  )
                : t(
                    'auto.components.settings.TerminalPane.e0996d141a',
                    'Auto tries WebGL, with DOM fallback for unsupported or risky renderers.'
                  )
          }
          control={
            <SettingsSegmentedControl
              ariaLabel={t('auto.components.settings.TerminalPane.c1fc9e9444', 'GPU Acceleration')}
              value={settings.terminalGpuAcceleration ?? 'auto'}
              onChange={(option) => updateSettings({ terminalGpuAcceleration: option })}
              options={[
                {
                  value: 'auto',
                  label: t('auto.components.settings.TerminalPane.43c2ff7b0e', 'Auto')
                },
                {
                  value: 'on',
                  label: t('auto.components.settings.TerminalPane.9c0b1c1792', 'On')
                },
                {
                  value: 'off',
                  label: t('auto.components.settings.TerminalPane.3fe1c5bfe0', 'Off')
                }
              ]}
            />
          }
        />
      </SearchableSetting>

      <TerminalContrastSetting settings={settings} updateSettings={updateSettings} />

      <SearchableSetting
        title={t('auto.components.settings.TerminalRenderingSection.6d4c55bacc', 'Inline Images')}
        description={t(
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
          label={t('auto.components.settings.TerminalRenderingSection.6d4c55bacc', 'Inline Images')}
          description={t(
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
    </SettingsGroup>
  )
}
