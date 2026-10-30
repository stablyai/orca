import type { ITheme } from '@xterm/xterm'

import { TERMINAL_THEME_CATALOG } from '../../../shared/terminal-themes'

export const TERMINAL_THEMES: Record<string, ITheme> = TERMINAL_THEME_CATALOG

export function getThemeNames(): string[] {
  return Object.keys(TERMINAL_THEMES).sort()
}

export function getTheme(name: string): ITheme | null {
  return TERMINAL_THEMES[name] ?? null
}
