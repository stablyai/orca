import type { ITheme } from '@xterm/xterm'

import { TERMINAL_THEME_CATALOG as TERMINAL_THEMES } from '../../../shared/terminal-themes/terminal-theme-catalog'

export function getThemeNames(): string[] {
  return Object.keys(TERMINAL_THEMES).sort()
}

export function getTheme(name: string): ITheme | null {
  // Why own-only: a repo pick from IPC/RPC like `constructor` must not resolve to an Object.prototype member.
  return Object.hasOwn(TERMINAL_THEMES, name) ? TERMINAL_THEMES[name] : null
}
