import { TERMINAL_THEME_CATALOG } from '../../../../../shared/terminal-themes/terminal-theme-catalog'
import type { ITheme } from '@xterm/xterm'

export function getThemeNames(): string[] {
  return Object.keys(TERMINAL_THEME_CATALOG).sort()
}

export function getTheme(name: string): ITheme | null {
  // Why own-only: a repo pick from IPC/RPC like `constructor` must not resolve to an Object.prototype member.
  return Object.hasOwn(TERMINAL_THEME_CATALOG, name) ? TERMINAL_THEME_CATALOG[name] : null
}
