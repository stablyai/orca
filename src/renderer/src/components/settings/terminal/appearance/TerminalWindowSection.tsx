import { useState } from 'react'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import {
  TERMINAL_COLOR_OVERRIDES_SETTING,
  terminalColorOverridesForSlot,
  type TerminalThemeSlot
} from '../../../../../../shared/terminal-themes/terminal-color-overrides'
import { Button } from '../../../ui/button'
import { Label } from '../../../ui/label'
import { Switch } from '../../../ui/switch'
import { ColorField, NumberField } from '../../form-controls/SettingsFormControls'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { clampNumber } from '@/lib/terminal-theme'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { WindowMaterialSetting } from '../../appearance/WindowMaterialSetting'
import { useTranslate } from '@/i18n/use-translate'

import { COLOR_OVERRIDE_GROUPS } from './terminal-window-color-groups'

type TerminalWindowSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  /** Theme slot the Color Overrides editor writes, following the theme catalog's Dark/Light target. */
  colorOverrideSlot: TerminalThemeSlot
}

export function TerminalWindowSection({
  settings,
  updateSettings,
  colorOverrideSlot
}: TerminalWindowSectionProps): React.JSX.Element {
  const t = useTranslate()
  const [colorOverridesExpanded, setColorOverridesExpanded] = useState(false)
  const colorOverridesSetting = TERMINAL_COLOR_OVERRIDES_SETTING[colorOverrideSlot]
  const colorOverrides = terminalColorOverridesForSlot(settings, colorOverrideSlot)

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">
          {t('auto.components.settings.TerminalWindowSection.b96ba13ed1', 'Window')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.TerminalWindowSection.00eaa6b881',
            'Window appearance and background settings.'
          )}
        </p>
      </div>

      <div className="ml-4 space-y-4">
        <SearchableSetting
          title={t(
            'auto.components.settings.TerminalWindowSection.e80b782206',
            'Background opacity'
          )}
          description={t(
            'auto.components.settings.TerminalWindowSection.03acb60aa0',
            'Controls the transparency of the terminal background.'
          )}
          keywords={['opacity', 'transparency', 'background', 'alpha']}
        >
          <NumberField
            label={t(
              'auto.components.settings.TerminalWindowSection.e80b782206',
              'Background opacity'
            )}
            description={t(
              'auto.components.settings.TerminalWindowSection.809f37738d',
              'Controls the transparency of the terminal background. 1 is fully opaque, 0 is fully transparent.'
            )}
            value={settings.terminalBackgroundOpacity ?? 1}
            defaultValue={1}
            min={0}
            max={1}
            step={0.05}
            suffix="0 to 1"
            onChange={(value) =>
              updateSettings({ terminalBackgroundOpacity: clampNumber(value, 0, 1) })
            }
          />
        </SearchableSetting>

        {isWebClientLocation() ? null : (
          <SearchableSetting
            title={t('settings.windowMaterial.fc2ba9b528', 'Window material')}
            description={t(
              'settings.windowMaterial.description',
              'What shows behind translucent terminals. Requires restart.'
            )}
            keywords={['window', 'blur', 'background', 'transparency', 'vibrancy', 'acrylic']}
            className="space-y-3 py-2"
          >
            <WindowMaterialSetting settings={settings} updateSettings={updateSettings} />
          </SearchableSetting>
        )}

        <SearchableSetting
          title={t(
            'auto.components.settings.TerminalWindowSection.2d8a13cabd',
            'Horizontal padding'
          )}
          description={t(
            'auto.components.settings.TerminalWindowSection.25e2f8e8e1',
            'Horizontal padding around the terminal grid in pixels.'
          )}
          keywords={['padding', 'horizontal', 'spacing', 'margin']}
        >
          <NumberField
            label={t(
              'auto.components.settings.TerminalWindowSection.2d8a13cabd',
              'Horizontal padding'
            )}
            description=""
            value={settings.terminalPaddingX ?? 4}
            defaultValue={4}
            min={0}
            max={512}
            step={1}
            suffix="px"
            onChange={(value) => updateSettings({ terminalPaddingX: Math.max(0, value) })}
          />
        </SearchableSetting>

        <SearchableSetting
          title={t('auto.components.settings.TerminalWindowSection.44c6f429e9', 'Vertical padding')}
          description={t(
            'auto.components.settings.TerminalWindowSection.1846f6ee6a',
            'Vertical padding around the terminal grid in pixels.'
          )}
          keywords={['padding', 'vertical', 'spacing', 'margin']}
        >
          <NumberField
            label={t(
              'auto.components.settings.TerminalWindowSection.44c6f429e9',
              'Vertical padding'
            )}
            description=""
            value={settings.terminalPaddingY ?? 4}
            defaultValue={4}
            min={0}
            max={512}
            step={1}
            suffix="px"
            onChange={(value) => updateSettings({ terminalPaddingY: Math.max(0, value) })}
          />
        </SearchableSetting>

        <SearchableSetting
          title={t(
            'auto.components.settings.TerminalWindowSection.a649973dd3',
            'Hide mouse while typing'
          )}
          description={t(
            'auto.components.settings.TerminalWindowSection.1d1920dc8a',
            'Hide the mouse cursor when typing in the terminal.'
          )}
          keywords={['mouse', 'hide', 'typing', 'cursor']}
          className="flex items-center justify-between gap-4 py-2"
        >
          <div className="space-y-0.5">
            <Label>
              {t(
                'auto.components.settings.TerminalWindowSection.a649973dd3',
                'Hide mouse while typing'
              )}
            </Label>
          </div>
          <Switch
            aria-label={t(
              'auto.components.settings.TerminalWindowSection.a649973dd3',
              'Hide mouse while typing'
            )}
            checked={settings.terminalMouseHideWhileTyping ?? false}
            onCheckedChange={(checked) =>
              updateSettings({
                terminalMouseHideWhileTyping: checked
              })
            }
          />
        </SearchableSetting>

        <SearchableSetting
          title={t('auto.components.settings.TerminalWindowSection.c9d73aee44', 'Color overrides')}
          description={t(
            'auto.components.settings.TerminalWindowSection.e86e09b5c7',
            'Override individual terminal colors.'
          )}
          keywords={['color', 'override', 'ansi', 'palette', 'theme']}
          className="space-y-3"
        >
          <div className="space-y-2">
            <button
              onClick={() => setColorOverridesExpanded((prev) => !prev)}
              className="flex items-center gap-2 text-sm font-medium"
            >
              <span className={`transition-transform ${colorOverridesExpanded ? 'rotate-90' : ''}`}>
                ▶
              </span>
              {t('auto.components.settings.TerminalWindowSection.c9d73aee44', 'Color overrides')}
            </button>
            <div
              className={`grid overflow-hidden transition-all duration-300 ease-out ${
                colorOverridesExpanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
              }`}
            >
              <div className="min-h-0 space-y-4">
                <p className="text-xs text-muted-foreground">
                  {colorOverrideSlot === 'light'
                    ? t(
                        'auto.components.settings.TerminalWindowSection.color_overrides_light_description',
                        'Override individual colors of the light terminal theme.'
                      )
                    : t(
                        'auto.components.settings.TerminalWindowSection.color_overrides_dark_description',
                        'Override individual colors of the dark terminal theme.'
                      )}
                </p>
                {COLOR_OVERRIDE_GROUPS.map((group) => (
                  <div key={group.label} className="space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground">{group.label}</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {group.keys.map((item) => (
                        <ColorField
                          key={item.key}
                          label={item.label}
                          description={item.description}
                          value={colorOverrides?.[item.key] ?? ''}
                          fallback=""
                          onChange={(value) =>
                            updateSettings({
                              [colorOverridesSetting]: {
                                ...colorOverrides,
                                [item.key]: value || undefined
                              }
                            })
                          }
                        />
                      ))}
                    </div>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => updateSettings({ [colorOverridesSetting]: undefined })}
                >
                  {colorOverrideSlot === 'light'
                    ? t(
                        'auto.components.settings.TerminalWindowSection.reset_light_color_overrides',
                        'Reset light color overrides'
                      )
                    : t(
                        'auto.components.settings.TerminalWindowSection.reset_dark_color_overrides',
                        'Reset dark color overrides'
                      )}
                </Button>
              </div>
            </div>
          </div>
        </SearchableSetting>
      </div>
    </section>
  )
}
