import { TERMINAL_THEME_CATALOG } from '../../../../../shared/terminal-themes/terminal-theme-catalog'
import type { ITheme } from '@xterm/xterm'

export function getThemeNames(): string[] {
  return Object.keys(TERMINAL_THEME_CATALOG).sort()
}

export function getTheme(name: string): ITheme | null {
  return TERMINAL_THEME_CATALOG[name] ?? null
}
