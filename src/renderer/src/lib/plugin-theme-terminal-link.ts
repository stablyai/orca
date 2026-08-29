import type { GlobalSettings } from '../../../shared/types'
import type { PluginThemeRegistration } from '../../../shared/plugins/plugin-theme-artifact'

type LinkedThemeSettings = Pick<
  Partial<GlobalSettings>,
  | 'theme'
  | 'pluginAppTheme'
  | 'terminalThemeDark'
  | 'terminalThemeLight'
  | 'terminalUseSeparateLightTheme'
>

export function getPluginThemeSettingsUpdate(
  theme: PluginThemeRegistration,
  settings: LinkedThemeSettings
): Partial<GlobalSettings> | null {
  if (settings.pluginAppTheme === theme.id) {
    return null
  }

  const updates: Partial<GlobalSettings> = {}
  if (settings.theme !== theme.base) {
    updates.theme = theme.base
  }
  if (theme.terminalThemeId) {
    if (theme.base === 'light') {
      if (!settings.terminalUseSeparateLightTheme) {
        updates.terminalUseSeparateLightTheme = true
      }
      if (settings.terminalThemeLight !== theme.terminalThemeId) {
        updates.terminalThemeLight = theme.terminalThemeId
      }
    } else if (settings.terminalThemeDark !== theme.terminalThemeId) {
      updates.terminalThemeDark = theme.terminalThemeId
    }
  }
  return Object.keys(updates).length > 0 ? updates : null
}
