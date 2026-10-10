import type { GlobalSettings } from './global-settings-types'
import {
  normalizeTerminalCustomThemes,
  parseCustomTerminalThemeSelection,
  terminalCustomThemeToXtermTheme
} from './terminal-custom-themes'
import type { TerminalOscColorQueryReplyColors } from './terminal-osc-color-reply'
import { TERMINAL_THEME_CATALOG } from './terminal-themes'
import type { TerminalThemeMap } from './terminal-themes/types'

export const DEFAULT_TERMINAL_THEME_DARK = 'Ghostty Default Style Dark'
export const DEFAULT_TERMINAL_THEME_LIGHT = 'Builtin Tango Light'

export type TerminalThemeSelectionSettings = Pick<
  GlobalSettings,
  'theme' | 'terminalThemeDark' | 'terminalUseSeparateLightTheme' | 'terminalThemeLight'
>

export type TerminalThemeSelection = {
  mode: 'dark' | 'light'
  useLightVariant: boolean
  themeName: string
}

/** Which terminal theme the app's appearance settings select; one rule for the renderer and main. */
export function selectTerminalTheme(
  settings: TerminalThemeSelectionSettings,
  systemPrefersDark: boolean
): TerminalThemeSelection {
  const mode = settings.theme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : settings.theme
  const useLightVariant = mode === 'light' && settings.terminalUseSeparateLightTheme
  const themeName = useLightVariant
    ? settings.terminalThemeLight || DEFAULT_TERMINAL_THEME_LIGHT
    : settings.terminalThemeDark || DEFAULT_TERMINAL_THEME_DARK
  return { mode, useLightVariant, themeName }
}

/** A selection names a user-imported theme or a built-in one; one lookup for both. */
export function lookupTerminalTheme(
  settings: Pick<GlobalSettings, 'terminalCustomThemes'> | undefined,
  selection: string
): TerminalThemeMap[string] | null {
  const customId = parseCustomTerminalThemeSelection(selection)
  const custom =
    customId && settings
      ? normalizeTerminalCustomThemes(settings.terminalCustomThemes).find(
          ({ id }) => id === customId
        )
      : undefined
  return custom
    ? terminalCustomThemeToXtermTheme(custom)
    : (TERMINAL_THEME_CATALOG[selection] ?? null)
}

function themeColors(
  selection: string,
  settings: Pick<GlobalSettings, 'terminalCustomThemes'>
): TerminalOscColorQueryReplyColors | null {
  const theme = lookupTerminalTheme(settings, selection)
  return theme ? { foreground: theme.foreground, background: theme.background } : null
}

/**
 * The foreground/background the host's saved settings paint a terminal with, for answering
 * OSC 10/11 before (or without) a renderer. Opacity is ignored: a colour query reports the
 * opaque theme colour.
 */
export function resolveConfiguredTerminalColors(
  settings: TerminalThemeSelectionSettings &
    Pick<GlobalSettings, 'terminalCustomThemes' | 'terminalColorOverrides'>,
  systemPrefersDark: boolean
): TerminalOscColorQueryReplyColors {
  const { themeName, useLightVariant } = selectTerminalTheme(settings, systemPrefersDark)
  const fallback = useLightVariant ? DEFAULT_TERMINAL_THEME_LIGHT : DEFAULT_TERMINAL_THEME_DARK
  const base: TerminalOscColorQueryReplyColors =
    themeColors(themeName, settings) ?? themeColors(fallback, settings) ?? {}
  const foreground = settings.terminalColorOverrides?.foreground ?? base.foreground
  const background = settings.terminalColorOverrides?.background ?? base.background
  return { ...(foreground ? { foreground } : {}), ...(background ? { background } : {}) }
}
