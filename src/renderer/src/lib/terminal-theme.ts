import type { ITheme } from '@xterm/xterm'
import { getTheme, getThemeNames } from './terminal-themes-data'
import type { GlobalSettings } from '../../../shared/types'

export const BUILTIN_TERMINAL_THEME_NAMES = getThemeNames()

export const DEFAULT_TERMINAL_THEME_DARK = 'Ghostty Default Style Dark'
export const DEFAULT_TERMINAL_THEME_LIGHT = 'Builtin Tango Light'
export const DEFAULT_TERMINAL_DIVIDER_DARK = '#3f3f46'
export const DEFAULT_TERMINAL_DIVIDER_LIGHT = '#d4d4d8'

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

export function buildTerminalFontMatchers(fontFamily: string): string[] {
  const trimmed = fontFamily.trim()
  const normalized = trimmed.toLowerCase()
  const matchers = trimmed ? [trimmed, normalized] : []
  return Array.from(
    new Set([
      ...matchers,
      'sf mono',
      'sfmono-regular',
      'menlo',
      'menlo regular',
      'dejavu sans mono',
      'liberation mono',
      'ubuntu mono',
      'monospace'
    ])
  )
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
  >
) {
  return {
    inactivePaneOpacity: clampNumber(settings.terminalInactivePaneOpacity, 0, 1),
    activePaneOpacity: clampNumber(settings.terminalActivePaneOpacity, 0, 1),
    opacityTransitionMs: clampNumber(settings.terminalPaneOpacityTransitionMs, 0, 5000),
    dividerThicknessPx: clampNumber(settings.terminalDividerThicknessPx, 1, 32)
  }
}

export function getCursorStyleSequence(
  style: 'bar' | 'block' | 'underline',
  blinking: boolean
): string {
  const code =
    style === 'block'
      ? blinking
        ? 1
        : 2
      : style === 'underline'
        ? blinking
          ? 3
          : 4
        : blinking
          ? 5
          : 6

  return `\u001b[${code} q`
}

export function colorToCss(
  color: { r: number; g: number; b: number; a?: number } | string | undefined,
  fallback: string
): string {
  if (!color) {
    return fallback
  }
  if (typeof color === 'string') {
    return color
  }
  const alpha = typeof color.a === 'number' ? color.a / 255 : 1
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha})`
}

const PALETTE_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const

export function terminalPalettePreview(theme: ITheme | null): string[] {
  if (!theme) {
    return []
  }
  const swatches: string[] = []
  for (const key of PALETTE_KEYS) {
    const color = theme[key]
    if (color) {
      swatches.push(color)
    }
  }
  return swatches
}
