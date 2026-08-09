import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import {
  resetTerminalColorOverridesForMode,
  resolveTerminalColorOverridesForMode,
  updateTerminalColorOverrideKey,
  type TerminalColorOverrideMode
} from '../../../../shared/terminal-color-overrides'
import { Button } from '../ui/button'
import { ColorField, SettingsSegmentedControl } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { COLOR_OVERRIDE_GROUPS } from './terminal-window-color-groups'
import { translate } from '@/i18n/i18n'

type TerminalColorOverridesSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function TerminalColorOverridesSection({
  settings,
  updateSettings
}: TerminalColorOverridesSectionProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [mode, setMode] = useState<TerminalColorOverrideMode>('dark')
  const activeOverrides = resolveTerminalColorOverridesForMode(settings, mode) ?? {}
  const lightMatchesDark = mode === 'light' && !settings.terminalUseSeparateLightTheme

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.TerminalWindowSection.63f8d9336e',
        'Color Overrides'
      )}
      description={translate(
        'auto.components.settings.TerminalWindowSection.color_overrides_mode_description',
        'Override individual terminal colors per appearance mode.'
      )}
      keywords={['color', 'override', 'ansi', 'palette', 'theme', 'dark', 'light']}
      className="space-y-3"
    >
      <div className="space-y-2">
        <button
          onClick={() => setExpanded((prev) => !prev)}
          className="flex items-center gap-2 text-sm font-medium"
        >
          <span className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
          {translate(
            'auto.components.settings.TerminalWindowSection.63f8d9336e',
            'Color Overrides'
          )}
        </button>
        <div
          className={`grid overflow-hidden transition-all duration-300 ease-out ${
            expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="min-h-0 space-y-4">
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {translate(
                  'auto.components.settings.TerminalWindowSection.color_overrides_mode_title',
                  'Override mode'
                )}
              </p>
              <SettingsSegmentedControl
                value={mode}
                onChange={setMode}
                ariaLabel={translate(
                  'auto.components.settings.TerminalWindowSection.color_overrides_mode_aria',
                  'Terminal color override mode'
                )}
                equalWidth
                options={[
                  {
                    value: 'dark',
                    label: translate(
                      'auto.components.settings.TerminalThemeSections.target_dark',
                      'Dark'
                    )
                  },
                  {
                    value: 'light',
                    label: translate(
                      'auto.components.settings.TerminalThemeSections.target_light',
                      'Light'
                    )
                  }
                ]}
              />
              {lightMatchesDark ? (
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.settings.TerminalWindowSection.color_overrides_match_dark_hint',
                    'Light mode currently matches dark theme settings, so these dark overrides also apply in light mode. Turn off “Match dark mode” under Terminal Themes to keep light overrides separate.'
                  )}
                </p>
              ) : null}
            </div>

            {COLOR_OVERRIDE_GROUPS.map((group) => (
              <div key={group.label} className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground">{group.label}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {group.keys.map((item) => (
                    <ColorField
                      key={item.key}
                      label={item.label}
                      description={item.description}
                      value={activeOverrides[item.key] ?? ''}
                      fallback=""
                      onChange={(value) =>
                        updateSettings(
                          updateTerminalColorOverrideKey(
                            settings,
                            mode,
                            item.key,
                            value || undefined
                          )
                        )
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onClick={() => updateSettings(resetTerminalColorOverridesForMode(settings, mode))}
            >
              {translate(
                'auto.components.settings.TerminalWindowSection.03c855d15f',
                'Reset {{value0}} color overrides',
                { value0: mode }
              )}
            </Button>
          </div>
        </div>
      </div>
    </SearchableSetting>
  )
}
