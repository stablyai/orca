import type { ITheme } from '@xterm/xterm'

import {
  TERMINAL_THEME_CATALOG,
  getSharedTerminalTheme,
  getTerminalThemeNames
} from '../../../shared/terminal-themes'

export const TERMINAL_THEMES: Record<string, ITheme> = TERMINAL_THEME_CATALOG

export function getThemeNames(): string[] {
  return getTerminalThemeNames()
}

export function getTheme(name: string): ITheme | null {
  return getSharedTerminalTheme(name)
}
