import type { ITheme } from '@xterm/xterm'
import { getTheme, getThemeNames } from './terminal-themes-data'
import type { GlobalSettings } from '../../../shared/types'

export const BUILTIN_TERMINAL_THEME_NAMES = getThemeNames()

export const DEFAULT_TERMINAL_THEME_DARK = 'Ghostty Default Style Dark'
export const DEFAULT_TERMINAL_THEME_LIGHT = 'Builtin Tango Light'
export const DEFAULT_TERMINAL_DIVIDER_DARK = '#3f3f46'
const DEFAULT_TERMINAL_DIVIDER_LIGHT = '#d4d4d8'

export type EffectiveTerminalAppearance = {
  mode: 'dark' | 'light'
  sourceTheme: 'system' | 'dark' | 'light'
  themeName: string
  dividerColor: string
  theme: ITheme | null
  systemPrefersDark: boolean
}

export function getSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function getBuiltinTheme(name: string): ITheme | null {
  return getTheme(name)
}

export function getTerminalThemePreview(name: string): ITheme | null {
  const theme = getTheme(name)
  if (theme) {
    return theme
  }
  return getTheme(DEFAULT_TERMINAL_THEME_DARK)
}

export function resolveEffectiveTerminalAppearance(
  settings: Pick<
    GlobalSettings,
    | 'theme'
    | 'terminalThemeDark'
    | 'terminalDividerColorDark'
    | 'terminalUseSeparateLightTheme'
    | 'terminalThemeLight'
    | 'terminalDividerColorLight'
  >,
  systemPrefersDark = getSystemPrefersDark()
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
    theme: getTerminalThemePreview(themeName),
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

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function resolvePaneStyleOptions(
  settings: Pick<
    GlobalSettings,
    | 'terminalInactivePaneOpacity'
    | 'terminalActivePaneOpacity'
    | 'terminalPaneOpacityTransitionMs'
    | 'terminalDividerThicknessPx'
    | 'terminalFocusFollowsMouse'
  >
) {
  return {
    inactivePaneOpacity: clampNumber(settings.terminalInactivePaneOpacity, 0, 1),
    activePaneOpacity: clampNumber(settings.terminalActivePaneOpacity, 0, 1),
    opacityTransitionMs: clampNumber(settings.terminalPaneOpacityTransitionMs, 0, 5000),
    dividerThicknessPx: clampNumber(settings.terminalDividerThicknessPx, 1, 32),
    // Why no clamping: boolean pass-through. Both true and false are valid.
    focusFollowsMouse: settings.terminalFocusFollowsMouse
  }
}

export { isTerminalBackgroundLight } from './terminal-title-contrast'
