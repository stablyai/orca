import type { GlobalSettings } from './global-settings-types'
import {
  hasUsableTerminalThemeColors,
  normalizeTerminalColorOverrides,
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

/** A selection names a plugin, user-imported or built-in theme; one lookup for all three. */
export function lookupTerminalTheme(
  settings: Pick<GlobalSettings, 'terminalCustomThemes' | 'terminalPluginPalettes'> | undefined,
  selection: string
): TerminalThemeMap[string] | null {
  if (selection.startsWith('plugin:')) {
    return pluginPalette(settings?.terminalPluginPalettes, selection)
  }
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

// Why re-validate: settings are persisted and synced, so a snapshot is untrusted input here.
function pluginPalette(palettes: unknown, selection: string): TerminalThemeMap[string] | null {
  if (!Array.isArray(palettes)) {
    return null
  }
  const entry: unknown = palettes.find(
    (candidate: unknown) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'id' in candidate &&
      candidate.id === selection
  )
  const colors = normalizeTerminalColorOverrides(
    typeof entry === 'object' && entry !== null && 'colors' in entry ? entry.colors : undefined
  )
  return hasUsableTerminalThemeColors(colors) ? colors : null
}

function themeColors(
  selection: string,
  settings: Pick<GlobalSettings, 'terminalCustomThemes' | 'terminalPluginPalettes'>
): TerminalOscColorQueryReplyColors | null {
  const theme = lookupTerminalTheme(settings, selection)
  return theme ? { foreground: theme.foreground, background: theme.background } : null
}

/** Answer OSC 10/11 from saved settings without a renderer; queries report opaque theme colors, ignoring opacity. */
export function resolveConfiguredTerminalColors(
  settings: TerminalThemeSelectionSettings &
    Pick<
      GlobalSettings,
      'terminalCustomThemes' | 'terminalPluginPalettes' | 'terminalColorOverrides'
    >,
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
