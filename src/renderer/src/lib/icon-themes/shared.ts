import type { IconTheme } from './types'

export type IconThemeMap = Record<string, IconTheme>

/** Mirrors `mergeFileExplorerColorThemeCatalogs`. Later sources win on id. */
export function mergeIconThemeCatalogs(...catalogs: readonly IconTheme[][]): IconThemeMap {
  const out: IconThemeMap = {}
  for (const catalog of catalogs) {
    for (const theme of catalog) {
      out[theme.id] = theme
    }
  }
  return out
}
