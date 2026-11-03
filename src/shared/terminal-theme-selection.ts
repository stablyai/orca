import type { ITheme } from '@xterm/xterm'
import type { GlobalSettings } from './global-settings-types'
import { isPluginContentSwitchedOff } from './plugins/plugin-system-settings'
import {
  hasTerminalColorOverrides,
  TERMINAL_COLOR_OVERRIDES_SETTING,
  terminalColorOverridesForSlot,
  withTerminalColorOverrides,
  type TerminalColorOverrideSettings,
  type TerminalThemeSlot
} from './terminal-color-overrides'
import {
  hasUsableTerminalThemeColors,
  makeCustomTerminalThemeSelection,
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

/** Settings a terminal theme lookup reads; plugin switches decide whether a plugin palette paints. */
export type TerminalThemeLookupSettings = Pick<
  GlobalSettings,
  'terminalCustomThemes' | 'terminalPluginPalettes'
> &
  Partial<Pick<GlobalSettings, 'pluginSystemEnabled' | 'disabledPlugins'>>

/** A selection names a plugin, user-imported or built-in theme; one lookup for all three. */
export function lookupTerminalTheme(
  settings: TerminalThemeLookupSettings | undefined,
  selection: string
): TerminalThemeMap[string] | null {
  if (selection.startsWith('plugin:')) {
    // Why: like app and icon themes, a switched-off plugin's palette falls back to the default
    // but stays saved, so turning the plugin back on restores it.
    return isPluginContentSwitchedOff(settings, selection)
      ? null
      : pluginPalette(settings?.terminalPluginPalettes, selection)
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

export type TerminalPaletteSettings = TerminalThemeSelectionSettings &
  TerminalThemeLookupSettings &
  TerminalColorOverrideSettings

export type TerminalPalette = TerminalThemeSelection & { theme: ITheme | null }

/** The one place a mode's terminal palette is composed: its slot's theme (or that slot's default) plus the slot's overrides. */
export function resolveTerminalPalette(
  settings: TerminalPaletteSettings,
  systemPrefersDark: boolean
): TerminalPalette {
  const selection = selectTerminalTheme(settings, systemPrefersDark)
  const slot = selection.useLightVariant ? 'light' : 'dark'
  const base =
    lookupTerminalTheme(settings, selection.themeName) ??
    lookupTerminalTheme(
      settings,
      selection.useLightVariant ? DEFAULT_TERMINAL_THEME_LIGHT : DEFAULT_TERMINAL_THEME_DARK
    )
  return {
    ...selection,
    theme: base && withTerminalColorOverrides(base, terminalColorOverridesForSlot(settings, slot))
  }
}

type TerminalCustomThemeRemovalSettings = Pick<
  GlobalSettings,
  'terminalCustomThemes' | 'terminalThemeDark' | 'terminalThemeLight'
> &
  TerminalColorOverrideSettings

export type TerminalCustomThemeRemoval = {
  updates: Partial<GlobalSettings>
  /** Puts the theme back unless re-imported since, and back into slots nobody changed since. */
  undo: (current: TerminalCustomThemeRemovalSettings) => Partial<GlobalSettings>
}

const SLOT_THEME_SETTING = {
  dark: 'terminalThemeDark',
  light: 'terminalThemeLight'
} as const satisfies Record<TerminalThemeSlot, keyof GlobalSettings>
const SLOT_DEFAULT_THEME: Record<TerminalThemeSlot, string> = {
  dark: DEFAULT_TERMINAL_THEME_DARK,
  light: DEFAULT_TERMINAL_THEME_LIGHT
}

/** Deleting an imported theme moves each slot showing it to that slot's default, dropping the slot's overrides like any theme change. */
export function terminalCustomThemeRemoval(
  settings: TerminalCustomThemeRemovalSettings,
  themeId: string
): TerminalCustomThemeRemoval {
  const themes = normalizeTerminalCustomThemes(settings.terminalCustomThemes)
  const removed = themes.find(({ id }) => id === themeId)
  const selection = makeCustomTerminalThemeSelection(themeId)
  const slots = (['dark', 'light'] as const).filter(
    (slot) => settings[SLOT_THEME_SETTING[slot]] === selection
  )
  const updates: Partial<GlobalSettings> = {
    terminalCustomThemes: themes.filter(({ id }) => id !== themeId)
  }
  for (const slot of slots) {
    updates[SLOT_THEME_SETTING[slot]] = SLOT_DEFAULT_THEME[slot]
    updates[TERMINAL_COLOR_OVERRIDES_SETTING[slot]] = undefined
  }
  return {
    updates,
    undo: (current) => {
      const restored: Partial<GlobalSettings> = {}
      const currentThemes = normalizeTerminalCustomThemes(current.terminalCustomThemes)
      if (removed && !currentThemes.some(({ id }) => id === themeId)) {
        restored.terminalCustomThemes = normalizeTerminalCustomThemes([...currentThemes, removed])
      }
      for (const slot of slots) {
        if (
          current[SLOT_THEME_SETTING[slot]] === SLOT_DEFAULT_THEME[slot] &&
          !hasTerminalColorOverrides(current, slot)
        ) {
          restored[SLOT_THEME_SETTING[slot]] = selection
          restored[TERMINAL_COLOR_OVERRIDES_SETTING[slot]] =
            settings[TERMINAL_COLOR_OVERRIDES_SETTING[slot]]
        }
      }
      return restored
    }
  }
}

/** An imported palette (Ghostty) merges into the slot painting the terminal once the import applies, so it shows. */
export function withImportedTerminalColorOverrides(
  settings: TerminalThemeSelectionSettings & TerminalColorOverrideSettings,
  diff: Partial<GlobalSettings>,
  systemPrefersDark: boolean
): Partial<GlobalSettings> {
  const { terminalColorOverrides: imported, ...rest } = diff
  if (!imported) {
    return diff
  }
  const { useLightVariant } = selectTerminalTheme({ ...settings, ...rest }, systemPrefersDark)
  const setting = TERMINAL_COLOR_OVERRIDES_SETTING[useLightVariant ? 'light' : 'dark']
  return { ...rest, [setting]: { ...settings[setting], ...imported } }
}

/** Answer OSC 10/11 from saved settings without a renderer; queries report opaque theme colors, ignoring opacity. */
export function resolveConfiguredTerminalColors(
  settings: TerminalPaletteSettings,
  systemPrefersDark: boolean
): TerminalOscColorQueryReplyColors {
  const { foreground, background } = resolveTerminalPalette(settings, systemPrefersDark).theme ?? {}
  return { ...(foreground ? { foreground } : {}), ...(background ? { background } : {}) }
}
