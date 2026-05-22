import type { FileExplorerColorTheme } from './types'

export type FileExplorerColorThemeMap = Record<string, FileExplorerColorTheme>

/**
 * Merge multiple theme catalogs into a single id-indexed registry. Mirrors
 * the pattern used by `terminal-themes/shared.ts#mergeTerminalThemeCatalogs`.
 *
 * Later sources win on id collision, but this should never happen for
 * built-ins — collisions surface a programming error, not a user concern.
 */
export function mergeFileExplorerColorThemeCatalogs(
  ...catalogs: readonly FileExplorerColorTheme[][]
): FileExplorerColorThemeMap {
  const out: FileExplorerColorThemeMap = {}
  for (const catalog of catalogs) {
    for (const theme of catalog) {
      out[theme.id] = theme
    }
  }
  return out
}
