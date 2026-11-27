import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
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
import { resolveTerminalImePreeditInGrid } from '@/lib/pane-manager/terminal-input/terminal-ime-grid-preedit'

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
        title={t('auto.components.settings.TerminalPane.37389522c6', 'GPU acceleration')}
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
          label={t('auto.components.settings.TerminalPane.37389522c6', 'GPU acceleration')}
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
              ariaLabel={t('auto.components.settings.TerminalPane.37389522c6', 'GPU acceleration')}
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
        title={t('auto.components.settings.TerminalRenderingSection.08db7947d8', 'Inline images')}
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
          label={t('auto.components.settings.TerminalRenderingSection.08db7947d8', 'Inline images')}
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
      <SearchableSetting
        title={t('terminal.recentImages.setting', 'Pasted and dropped image previews')}
        description={t(
          'terminal.recentImages.settingDescription',
          'Show recent local images in the pane header after you paste or drop them.'
        )}
        keywords={['terminal', 'paste', 'drop', 'image', 'preview']}
        className="py-2"
      >
        <SettingsSwitchRow
          label={t('terminal.recentImages.setting', 'Pasted and dropped image previews')}
          description={t(
            'terminal.recentImages.settingDescription',
            'Show recent local images in the pane header after you paste or drop them.'
          )}
          checked={settings.terminalDroppedImagesPreview !== false}
          onChange={() =>
            updateSettings({
              terminalDroppedImagesPreview: settings.terminalDroppedImagesPreview === false
            })
          }
        />
      </SearchableSetting>

      <SearchableSetting
        title={t(
          'components.settings.TerminalRendering.imePreeditInGrid',
          'Draw IME Composition in Terminal Cells'
        )}
        description={t(
          'components.settings.TerminalRendering.imePreeditInGridDescription',
          'Render text being composed with an input method (Korean, Japanese, Chinese) as terminal cells at the cursor. Turn off to use the floating overlay instead.'
        )}
        keywords={[
          'terminal',
          'ime',
          'input method',
          'composition',
          'preedit',
          'korean',
          'hangul',
          'japanese',
          'chinese',
          'cjk',
          'overlay'
        ]}
        className="py-2"
      >
        <SettingsSwitchRow
          label={t(
            'components.settings.TerminalRendering.imePreeditInGrid',
            'Draw IME Composition in Terminal Cells'
          )}
          description={t(
            'components.settings.TerminalRendering.imePreeditInGridDescription',
            'Render text being composed with an input method (Korean, Japanese, Chinese) as terminal cells at the cursor. Turn off to use the floating overlay instead.'
          )}
          checked={resolveTerminalImePreeditInGrid(settings.terminalImePreeditInGrid)}
          onChange={() =>
            updateSettings({
              terminalImePreeditInGrid: !resolveTerminalImePreeditInGrid(
                settings.terminalImePreeditInGrid
              )
            })
          }
        />
      </SearchableSetting>
    </SettingsGroup>
  )
}
