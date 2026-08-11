import { getBuiltinTerminalThemePalette } from './terminal-themes'
import {
  normalizeTerminalCustomThemes,
  parseCustomTerminalThemeSelection,
  terminalCustomThemeToXtermTheme,
  type TerminalCustomTheme
} from './terminal-custom-themes'
import type { GlobalSettings, TerminalColorOverrides } from './types'

export const DEFAULT_TERMINAL_THEME_DARK = 'Ghostty Default Style Dark'
export const DEFAULT_TERMINAL_THEME_LIGHT = 'Builtin Tango Light'
export const DEFAULT_TERMINAL_DIVIDER_DARK = '#3f3f46'
const DEFAULT_TERMINAL_DIVIDER_LIGHT = '#d4d4d8'

export type EffectiveTerminalAppearance = {
  mode: 'dark' | 'light'
  sourceTheme: 'system' | 'dark' | 'light'
  themeName: string
  dividerColor: string
  theme: TerminalColorOverrides | null
  systemPrefersDark: boolean
}

function findCustomTheme(
  settings: Pick<GlobalSettings, 'terminalCustomThemes'> | undefined,
  selection: string
): TerminalCustomTheme | null {
  const customId = parseCustomTerminalThemeSelection(selection)
  if (!customId || !settings) {
    return null
  }
  return (
    normalizeTerminalCustomThemes(settings.terminalCustomThemes).find(
      (theme) => theme.id === customId
    ) ?? null
  )
}

export function getTerminalTheme(
  settings: Pick<GlobalSettings, 'terminalCustomThemes'> | undefined,
  selection: string
): TerminalColorOverrides | null {
  const customTheme = findCustomTheme(settings, selection)
  if (customTheme) {
    return terminalCustomThemeToXtermTheme(customTheme)
  }
  return getBuiltinTerminalThemePalette(selection)
}

export function getTerminalThemePreview(
  name: string,
  settings?: Pick<GlobalSettings, 'terminalCustomThemes'>,
  fallbackMode: 'dark' | 'light' = 'dark'
): TerminalColorOverrides | null {
  const theme = getTerminalTheme(settings, name)
  if (theme) {
    return theme
  }
  return getBuiltinTerminalThemePalette(
    fallbackMode === 'light' ? DEFAULT_TERMINAL_THEME_LIGHT : DEFAULT_TERMINAL_THEME_DARK
  )
}

export function resolveEffectiveTerminalAppearance(
  settings: Pick<
    GlobalSettings,
    | 'theme'
    | 'terminalThemeDark'
    | 'terminalDividerColorDark'
    | 'terminalUseSeparateLightTheme'
    | 'terminalThemeLight'
    | 'terminalCustomThemes'
    | 'terminalDividerColorLight'
  >,
  // Why: no default — src/shared must stay DOM-free so main and Metro can import it.
  systemPrefersDark: boolean
): EffectiveTerminalAppearance {
  const sourceTheme =
    settings.theme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : settings.theme
  const useLightVariant = sourceTheme === 'light' && settings.terminalUseSeparateLightTheme
  const themeName = useLightVariant
    ? settings.terminalThemeLight || DEFAULT_TERMINAL_THEME_LIGHT
    : settings.terminalThemeDark || DEFAULT_TERMINAL_THEME_DARK
  const dividerColor = useLightVariant
    ? normalizeColor(settings.terminalDividerColorLight, DEFAULT_TERMINAL_DIVIDER_LIGHT)
    : normalizeColor(settings.terminalDividerColorDark, DEFAULT_TERMINAL_DIVIDER_DARK)

  return {
    mode: sourceTheme,
    sourceTheme: settings.theme,
    themeName,
    dividerColor,
    theme: getTerminalThemePreview(themeName, settings, useLightVariant ? 'light' : 'dark'),
    systemPrefersDark
  }
}

export function normalizeColor(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    return fallback
  }
  return trimmed
}
