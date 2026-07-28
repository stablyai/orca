import type { GlobalSettings } from '../../../../shared/types'

type TerminalThemeActivationSettings = Pick<
  GlobalSettings,
  'theme' | 'terminalThemeDark' | 'terminalUseSeparateLightTheme' | 'terminalThemeLight'
>

function usesLightTerminalSlot(
  settings: TerminalThemeActivationSettings,
  systemPrefersDark: boolean
): boolean {
  const appMode =
    settings.theme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : settings.theme
  return appMode === 'light' && settings.terminalUseSeparateLightTheme
}

export function activeTerminalThemeSelection(
  settings: TerminalThemeActivationSettings,
  systemPrefersDark: boolean
): string {
  return usesLightTerminalSlot(settings, systemPrefersDark)
    ? settings.terminalThemeLight
    : settings.terminalThemeDark
}

export function terminalThemeActivationUpdate(
  settings: TerminalThemeActivationSettings,
  themeId: `plugin:${string}`,
  systemPrefersDark: boolean
): Partial<GlobalSettings> {
  // Why: applying a pack should visibly affect the terminal mode the user is viewing now.
  return usesLightTerminalSlot(settings, systemPrefersDark)
    ? { terminalThemeLight: themeId }
    : { terminalThemeDark: themeId }
}
