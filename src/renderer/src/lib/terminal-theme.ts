import type { ITheme } from '@xterm/xterm'
import { getTheme, getThemeNames } from './terminal-themes-data'
import type { GlobalSettings } from '../../../shared/types'
import {
  makeCustomTerminalThemeSelection,
  normalizeTerminalCustomThemes,
  parseCustomTerminalThemeSelection,
  terminalCustomThemeToXtermTheme,
  type TerminalCustomTheme
} from '../../../shared/terminal-custom-themes'

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

export type TerminalThemeOption = {
  value: string
  label: string
  group: 'built-in' | 'imported'
  sourceLabel?: string
  mode?: TerminalCustomTheme['mode']
  previewTheme: ITheme | null
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
): ITheme | null {
  const customTheme = findCustomTheme(settings, selection)
  if (customTheme) {
    return terminalCustomThemeToXtermTheme(customTheme)
  }
  return getTheme(selection)
}

export function getTerminalThemePreview(
  name: string,
  settings?: Pick<GlobalSettings, 'terminalCustomThemes'>,
  fallbackMode: 'dark' | 'light' = 'dark'
): ITheme | null {
  const theme = getTerminalTheme(settings, name)
  if (theme) {
    return theme
  }
  return getTheme(
    fallbackMode === 'light' ? DEFAULT_TERMINAL_THEME_LIGHT : DEFAULT_TERMINAL_THEME_DARK
  )
}

export function getAvailableTerminalThemeOptions(
  settings: Pick<GlobalSettings, 'terminalCustomThemes'>
): TerminalThemeOption[] {
  const builtinOptions = BUILTIN_TERMINAL_THEME_NAMES.map((name) => ({
    value: name,
    label: name,
    group: 'built-in' as const,
    previewTheme: getTheme(name)
  }))
  const customOptions = normalizeTerminalCustomThemes(settings.terminalCustomThemes).map(
    (theme) => ({
      value: makeCustomTerminalThemeSelection(theme.id),
      label: theme.name,
      group: 'imported' as const,
      sourceLabel:
        theme.source === 'warp' ? 'Warp' : theme.source === 'ghostty' ? 'Ghostty' : 'Manual',
      mode: theme.mode,
      previewTheme: terminalCustomThemeToXtermTheme(theme)
    })
  )
  return [...builtinOptions, ...customOptions]
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
