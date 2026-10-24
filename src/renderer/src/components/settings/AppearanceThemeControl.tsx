import type React from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Button } from '../ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '../ui/select'
import { SettingsSegmentedControl } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { usePluginTerminalThemes, usePluginThemes } from '@/store/plugin-themes'
import { withTerminalPluginPalettes } from '@/lib/terminal-plugin-palettes'

type BuiltInTheme = GlobalSettings['theme']

type AppearanceThemeControlProps = {
  label: string
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  applyTheme: (theme: BuiltInTheme) => void
}

function builtInOptions(): { value: BuiltInTheme; label: string }[] {
  return [
    {
      value: 'system',
      label: translate('auto.components.settings.AppearancePane.fb0e0b4453', 'System')
    },
    {
      value: 'dark',
      label: translate('auto.components.settings.AppearancePane.7d26ccabe8', 'Dark')
    },
    {
      value: 'light',
      label: translate('auto.components.settings.AppearancePane.fd89b5487c', 'Light')
    }
  ]
}

/** One Theme choice: System, Dark and Light, then any enabled plugin themes. A plugin theme
 *  stores its base in `theme`, so every light/dark reader follows the painted colors. */
export function AppearanceThemeControl({
  label,
  settings,
  updateSettings,
  applyTheme
}: AppearanceThemeControlProps): React.JSX.Element {
  const pluginThemes = usePluginThemes()
  const pluginTerminalThemes = usePluginTerminalThemes()
  const selectBuiltIn = (theme: BuiltInTheme): void => {
    updateSettings({ theme, pluginAppTheme: null, themeBeforePlugin: null })
    applyTheme(theme)
  }
  if (pluginThemes.length === 0) {
    return (
      <SettingsSegmentedControl
        ariaLabel={label}
        value={settings.theme}
        onChange={selectBuiltIn}
        options={builtInOptions()}
      />
    )
  }
  const active = pluginThemes.find((theme) => theme.id === settings.pluginAppTheme)
  const terminalSlot =
    active?.base === 'light' && settings.terminalUseSeparateLightTheme
      ? 'terminalThemeLight'
      : 'terminalThemeDark'
  const matchingTerminal = active
    ? (pluginTerminalThemes.find(
        (theme) => theme.pluginKey === active.pluginKey && theme.id === active.id
      ) ?? pluginTerminalThemes.find((theme) => theme.pluginKey === active.pluginKey))
    : undefined
  return (
    <div className="flex flex-col items-end gap-1">
      <Select
        value={active?.id ?? settings.theme}
        onValueChange={(value) => {
          const pluginTheme = pluginThemes.find((theme) => theme.id === value)
          if (pluginTheme) {
            updateSettings({
              theme: pluginTheme.base,
              pluginAppTheme: pluginTheme.id,
              // Why keep the first one: switching between plugin themes must not lose it.
              themeBeforePlugin: settings.themeBeforePlugin ?? settings.theme
            })
            applyTheme(pluginTheme.base)
            return
          }
          const builtIn = builtInOptions().find((option) => option.value === value)
          if (builtIn) {
            selectBuiltIn(builtIn.value)
          }
        }}
      >
        <SelectTrigger size="sm" className="min-w-[220px]" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {builtInOptions().map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
          <SelectSeparator />
          {pluginThemes.map((theme) => (
            <SelectItem key={theme.id} value={theme.id}>
              {pluginThemes.filter((other) => other.label === theme.label).length > 1
                ? `${theme.label} · ${theme.pluginKey.split('.')[0]}`
                : theme.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {matchingTerminal && settings[terminalSlot] !== matchingTerminal.id ? (
        <Button
          variant="link"
          size="xs"
          onClick={() =>
            updateSettings(
              withTerminalPluginPalettes(
                settings,
                terminalSlot === 'terminalThemeLight'
                  ? { terminalThemeLight: matchingTerminal.id }
                  : { terminalThemeDark: matchingTerminal.id },
                pluginTerminalThemes
              )
            )
          }
        >
          {translate(
            'auto.components.settings.AppearanceThemeControl.useTerminalTheme',
            'Use its terminal colors'
          )}
        </Button>
      ) : null}
    </div>
  )
}
