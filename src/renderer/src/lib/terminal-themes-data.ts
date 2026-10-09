import type { ITheme } from '@xterm/xterm'

import { TERMINAL_THEME_CATALOG } from '../../../shared/terminal-themes'

export const TERMINAL_THEMES: Record<string, ITheme> = TERMINAL_THEME_CATALOG

export function getThemeNames(): string[] {
  return Object.keys(TERMINAL_THEMES).sort()
}

export function getTheme(name: string): ITheme | null {
  // Why own-only: a repo pick from IPC/RPC like `constructor` must not resolve to an Object.prototype member.
  return Object.hasOwn(TERMINAL_THEMES, name) ? TERMINAL_THEMES[name] : null
}
