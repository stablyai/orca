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

/** Directories-first, then natural name order — the File Explorer listing contract. */
export function compareDirEntries(
  a: { name: string; isDirectory: boolean },
  b: { name: string; isDirectory: boolean }
): number {
  if (a.isDirectory !== b.isDirectory) {
    return a.isDirectory ? -1 : 1
  }
  return compareFileNames(a.name, b.name)
}

export function sortDirEntries<T extends { name: string; isDirectory: boolean }>(
  entries: T[]
): T[] {
  return entries.sort(compareDirEntries)
}
