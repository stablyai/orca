import type { GlobalSettings } from './global-settings-types'
import type { RepoTerminalThemeOverrides } from './repo-terminal-theme'
import { lookupTerminalTheme } from './terminal-theme-selection'

export type RepoTerminalThemeOverrideTarget = Pick<
  GlobalSettings,
  | 'terminalThemeDark'
  | 'terminalThemeLight'
  | 'terminalUseSeparateLightTheme'
  | 'terminalCustomThemes'
>

function resolveRepoTerminalThemeSelection(
  settings: Pick<GlobalSettings, 'terminalCustomThemes'>,
  selection: string | undefined
): string | undefined {
  // Unresolvable selections (a deleted custom theme, another build's shape) fall back to global.
  return typeof selection === 'string' && selection && lookupTerminalTheme(settings, selection)
    ? selection
    : undefined
}

/**
 * Per variant: repo pick > global. Identity-preserving when no pick applies. One rule for the
 * renderer's panes and main's seed, so both resolve a project to the same theme.
 */
export function applyRepoTerminalThemeOverride<T extends RepoTerminalThemeOverrideTarget>(
  settings: T,
  pick: RepoTerminalThemeOverrides | undefined
): T {
  if (!pick) {
    return settings
  }
  const dark = resolveRepoTerminalThemeSelection(settings, pick.dark)
  const light = resolveRepoTerminalThemeSelection(settings, pick.light)
  if (!dark && !light) {
    return settings
  }
  return {
    ...settings,
    ...(dark ? { terminalThemeDark: dark } : {}),
    // Why force separate-light: an explicit repo light variant must win even when global light mirrors dark.
    ...(light ? { terminalThemeLight: light, terminalUseSeparateLightTheme: true } : {})
  }
}
