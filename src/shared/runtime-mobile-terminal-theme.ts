import type { RuntimeMobileTerminalTheme } from './runtime-types'
import { resolveEffectiveTerminalAppearance } from './terminal-theme-resolution'
import type { GlobalSettings } from './types'

export type RuntimeMobileTerminalThemeSettings = Partial<
  Pick<
    GlobalSettings,
    | 'theme'
    | 'terminalThemeDark'
    | 'terminalThemeLight'
    | 'terminalUseSeparateLightTheme'
    | 'terminalDividerColorDark'
    | 'terminalDividerColorLight'
    | 'terminalCustomThemes'
    | 'terminalColorOverrides'
    | 'terminalBackgroundOpacity'
    | 'terminalCursorOpacity'
  >
>

function hexToRgba(hex: string, alpha: number): string {
  let clean = hex.replace('#', '')
  if (clean.length === 3) {
    clean = clean
      .split('')
      .map((c) => c + c)
      .join('')
  }
  const r = Number.parseInt(clean.slice(0, 2), 16)
  const g = Number.parseInt(clean.slice(2, 4), 16)
  const b = Number.parseInt(clean.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function isHexColor(value: string | undefined): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
}

/** The palette a paired phone renders. Callers supply `systemPrefersDark`: the
 *  renderer measures it, main has no matchMedia and mirrors the renderer's dark bias. */
export function resolveRuntimeMobileTerminalTheme(
  settings: RuntimeMobileTerminalThemeSettings | null | undefined,
  systemPrefersDark: boolean
): RuntimeMobileTerminalTheme | undefined {
  if (!settings) {
    return undefined
  }
  const appearance = resolveEffectiveTerminalAppearance(
    {
      theme: settings.theme ?? 'system',
      terminalThemeDark: settings.terminalThemeDark ?? '',
      terminalThemeLight: settings.terminalThemeLight ?? '',
      // Why: the shipped default is true, but a narrowed store type makes the key optional.
      terminalUseSeparateLightTheme: settings.terminalUseSeparateLightTheme !== false,
      terminalDividerColorDark: settings.terminalDividerColorDark ?? '',
      terminalDividerColorLight: settings.terminalDividerColorLight ?? '',
      terminalCustomThemes: settings.terminalCustomThemes
    },
    systemPrefersDark
  )
  const resolvedTheme = appearance.theme
    ? { ...appearance.theme, ...settings.terminalColorOverrides }
    : undefined
  if (!resolvedTheme) {
    return undefined
  }
  if (settings.terminalBackgroundOpacity !== undefined && isHexColor(resolvedTheme.background)) {
    resolvedTheme.background = hexToRgba(
      resolvedTheme.background,
      settings.terminalBackgroundOpacity
    )
  }
  if (settings.terminalCursorOpacity !== undefined && isHexColor(resolvedTheme.cursor)) {
    resolvedTheme.cursor = hexToRgba(resolvedTheme.cursor, settings.terminalCursorOpacity)
  }

  const theme: Record<string, string> = {}
  for (const [key, value] of Object.entries(resolvedTheme)) {
    if (typeof value === 'string') {
      theme[key] = value
    }
  }
  return { mode: appearance.mode, theme: theme as RuntimeMobileTerminalTheme['theme'] }
}
