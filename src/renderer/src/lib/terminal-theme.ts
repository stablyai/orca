import type { ITheme } from '@xterm/xterm'
import {
  BUILTIN_TERMINAL_THEME_NAMES,
  getBuiltinTerminalThemePalette
} from '../../../shared/terminal-themes'
import type { GlobalSettings } from '../../../shared/types'
import {
  makeCustomTerminalThemeSelection,
  normalizeTerminalCustomThemes,
  terminalCustomThemeToXtermTheme,
  type TerminalCustomTheme
} from '../../../shared/terminal-custom-themes'

export { BUILTIN_TERMINAL_THEME_NAMES }

// Why: the resolver is shared with the main process (headless mobile tabs); this
// module stays the renderer's single import surface.
export {
  DEFAULT_TERMINAL_DIVIDER_DARK,
  DEFAULT_TERMINAL_THEME_DARK,
  DEFAULT_TERMINAL_THEME_LIGHT,
  getTerminalTheme,
  getTerminalThemePreview,
  normalizeColor,
  resolveEffectiveTerminalAppearance,
  type EffectiveTerminalAppearance
} from '../../../shared/terminal-theme-resolution'

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
  return getBuiltinTerminalThemePalette(name)
}

export function getAvailableTerminalThemeOptions(
  settings: Pick<GlobalSettings, 'terminalCustomThemes'>
): TerminalThemeOption[] {
  const builtinOptions = BUILTIN_TERMINAL_THEME_NAMES.map((name) => ({
    value: name,
    label: name,
    group: 'built-in' as const,
    previewTheme: getBuiltinTerminalThemePalette(name)
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

export {
  isTerminalBackgroundLight,
  resolveOpaqueTerminalBackground
} from './terminal-title-contrast'
