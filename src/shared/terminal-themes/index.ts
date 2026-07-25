import { CLASSIC_TERMINAL_THEMES } from './classic'
import { DEFAULT_TERMINAL_THEMES } from './defaults'
import { POPULAR_DARK_TERMINAL_THEMES } from './popular-dark'
import { POPULAR_LIGHT_TERMINAL_THEMES } from './popular-light'
import { mergeTerminalThemeCatalogs } from './catalog-merge'
import type { TerminalThemeMap } from './types'
import type { TerminalColorOverrides } from '../types'

const THEME_CATEGORIES: readonly TerminalThemeMap[] = [
  DEFAULT_TERMINAL_THEMES,
  POPULAR_DARK_TERMINAL_THEMES,
  POPULAR_LIGHT_TERMINAL_THEMES,
  CLASSIC_TERMINAL_THEMES
]

export const TERMINAL_THEME_CATALOG: TerminalThemeMap = mergeTerminalThemeCatalogs(
  ...THEME_CATEGORIES
)

// The display name IS the persisted id on desktop and mobile; renaming a built-in orphans saved selections.
export const BUILTIN_TERMINAL_THEME_NAMES: readonly string[] =
  Object.keys(TERMINAL_THEME_CATALOG).sort()

export function getBuiltinTerminalThemePalette(name: string): TerminalColorOverrides | null {
  // Own-property only — `toString`/`constructor`/`__proto__` must not resolve to Object.prototype.
  return Object.hasOwn(TERMINAL_THEME_CATALOG, name) ? TERMINAL_THEME_CATALOG[name] : null
}

export type { TerminalThemeMap } from './types'
