import type { TerminalThemeMap } from './types'

export function mergeTerminalThemeCatalogs(
  ...catalogs: readonly TerminalThemeMap[]
): TerminalThemeMap {
  const merged: TerminalThemeMap = {}

  for (const catalog of catalogs) {
    for (const [name, theme] of Object.entries(catalog)) {
      if (Object.prototype.hasOwnProperty.call(merged, name)) {
        throw new Error(`Duplicate terminal theme name: ${name}`)
      }
      merged[name] = theme
    }
  }

  return merged
}
