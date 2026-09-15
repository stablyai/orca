import type { TerminalThemeMap } from './types'

export function mergeTerminalThemeCatalogs(
  ...catalogs: readonly TerminalThemeMap[]
): TerminalThemeMap {
  // Null prototype so keys like `__proto__` / `constructor` stay data, never inherited methods.
  const merged: TerminalThemeMap = Object.create(null) as TerminalThemeMap

  for (const catalog of catalogs) {
    for (const [name, theme] of Object.entries(catalog)) {
      if (Object.hasOwn(merged, name)) {
        throw new Error(`Duplicate terminal theme name: ${name}`)
      }
      merged[name] = theme
    }
  }

  return merged
}
