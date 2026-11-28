// Hoisting avoids per-comparison ICU construction (~14x cost); numeric collation costs ~5x bare localeCompare.
// Numeric order matches Finder/Explorer (99 before 100); pin en so local/remote processes agree regardless of LANG.
export const fileNameCollator = new Intl.Collator('en', { numeric: true })

export function compareFileNames(a: string, b: string): number {
  const primary = fileNameCollator.compare(a, b)
  if (primary !== 0) {
    return primary
  }
  // Numeric ties (2 vs 02) need code-unit ordering to avoid readdir-dependent results.
  return a < b ? -1 : a > b ? 1 : 0
}

/** Where the File Explorer shows folders among files; listings and page cursors stay folders-first. */
export type FileExplorerSortMode = 'folders-first' | 'files-first' | 'mixed'

export function normalizeFileExplorerSortMode(value: unknown): FileExplorerSortMode {
  return value === 'files-first' || value === 'mixed' ? value : 'folders-first'
}

export function compareDirEntriesForSortMode(
  a: { name: string; isDirectory: boolean },
  b: { name: string; isDirectory: boolean },
  mode: FileExplorerSortMode
): number {
  if (mode !== 'mixed' && a.isDirectory !== b.isDirectory) {
    return a.isDirectory === (mode === 'folders-first') ? -1 : 1
  }
  return compareFileNames(a.name, b.name)
}

/** Directories-first, then natural name order — the File Explorer listing contract. */
export function compareDirEntries(
  a: { name: string; isDirectory: boolean },
  b: { name: string; isDirectory: boolean }
): number {
  return compareDirEntriesForSortMode(a, b, 'folders-first')
}

/** Display order of a folders-first listing; folders-first returns the same array. */
export function orderDirEntriesForSortMode<T extends { name: string; isDirectory: boolean }>(
  entries: readonly T[],
  mode: FileExplorerSortMode
): readonly T[] {
  if (mode === 'folders-first') {
    return entries
  }
  return [...entries].sort((a, b) => compareDirEntriesForSortMode(a, b, mode))
}

export function sortDirEntries<T extends { name: string; isDirectory: boolean }>(
  entries: T[]
): T[] {
  return entries.sort(compareDirEntries)
}
