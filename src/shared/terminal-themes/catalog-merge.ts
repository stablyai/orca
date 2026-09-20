import type { TerminalThemeMap } from './types'

export function mergeTerminalThemeCatalogs(
  ...catalogs: readonly TerminalThemeMap[]
): TerminalThemeMap {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Object.create(null) provides a prototype-less map matching TerminalThemeMap.
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
