import type { ITheme } from '@xterm/xterm'
import type { GlobalSettings } from './global-settings-types'

export type TerminalColorOverrides = {
  foreground?: string
  background?: string
  cursor?: string
  cursorAccent?: string
  selectionBackground?: string
  selectionForeground?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
  // Preserve Ghostty bold for future renderer support; xterm ITheme has no bold key.
  bold?: string
}

/** A selected plugin terminal theme's palette, saved so every host resolves it. */
export type TerminalPluginPalette = {
  id: `plugin:${string}`
  colors: TerminalColorOverrides
}

/** Terminal theme slot (the Dark/Light picker) an override bag tweaks; light mode paints the dark slot unless it has its own theme. */
export type TerminalThemeSlot = 'dark' | 'light'

export type TerminalColorOverrideGlobalSettings = {
  /** Dark slot's overrides; light mode uses them too unless terminalUseSeparateLightTheme. */
  terminalColorOverrides?: TerminalColorOverrides
  /** Light slot's overrides (#10561); older clients ignore them. */
  terminalColorOverridesLight?: TerminalColorOverrides
  /** One-shot migration guard for splitting the legacy shared bag per slot. */
  terminalColorOverridesSplit?: boolean
}

// Why the dark slot keeps the original key: older clients keep applying it in both modes, the pre-split behavior.
export const TERMINAL_COLOR_OVERRIDES_SETTING = {
  dark: 'terminalColorOverrides',
  light: 'terminalColorOverridesLight'
} as const satisfies Record<TerminalThemeSlot, keyof TerminalColorOverrideGlobalSettings>

export type TerminalColorOverrideSettings = Pick<
  TerminalColorOverrideGlobalSettings,
  'terminalColorOverrides' | 'terminalColorOverridesLight'
>

export function terminalColorOverridesForSlot(
  settings: TerminalColorOverrideSettings,
  slot: TerminalThemeSlot
): TerminalColorOverrides | undefined {
  return settings[TERMINAL_COLOR_OVERRIDES_SETTING[slot]]
}

export function hasTerminalColorOverrides(
  settings: TerminalColorOverrideSettings,
  slot: TerminalThemeSlot
): boolean {
  return Object.values(terminalColorOverridesForSlot(settings, slot) ?? {}).some(Boolean)
}

/** Cleared fields stay undefined in memory until reload; they must not blank the theme's color. */
export function withTerminalColorOverrides(
  theme: ITheme,
  overrides: TerminalColorOverrides | undefined
): ITheme {
  const painted = Object.entries(overrides ?? {}).filter(
    ([, value]) => typeof value === 'string' && value.length > 0
  )
  return painted.length === 0 ? theme : { ...theme, ...Object.fromEntries(painted) }
}

type LegacyTerminalColorOverrideSettings = TerminalColorOverrideGlobalSettings &
  Partial<Pick<GlobalSettings, 'theme' | 'terminalUseSeparateLightTheme'>>

/** One-shot split of the pre-#10561 shared bag. It stays on the dark slot; when the light slot could have shown it
 *  (own light theme, app not pinned dark) it is copied there too, so nothing changes on upgrade and older clients,
 *  which only read the dark key, keep their behavior. A missing separate-light flag means its default, on. */
export function splitLegacyTerminalColorOverrides(
  settings: LegacyTerminalColorOverrideSettings | undefined
): TerminalColorOverrideGlobalSettings {
  const shownInLight =
    settings?.terminalColorOverridesSplit !== true &&
    settings?.theme !== 'dark' &&
    settings?.terminalUseSeparateLightTheme !== false &&
    settings?.terminalColorOverridesLight === undefined
  return {
    terminalColorOverrides: settings?.terminalColorOverrides,
    terminalColorOverridesLight: shownInLight
      ? settings?.terminalColorOverrides
      : settings?.terminalColorOverridesLight,
    terminalColorOverridesSplit: true
  }
}
