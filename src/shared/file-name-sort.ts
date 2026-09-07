// Why hoisted: localeCompare with an options object resolves a fresh ICU collator
// on every comparison (~14x this form). Numeric collation itself costs ~5x over
// bare localeCompare — accepted for the feature; don't "optimize" the hoist away.
// numeric: true orders "99 - a" before "100 - b", matching Finder/Explorer.
// Locale pinned to 'en' so local main, renderer, relay, and remote runtime hosts
// all produce one order regardless of each process's LANG (precedent:
// skill-freshness pins 'en' for canonical ordering).
export const fileNameCollator = new Intl.Collator('en', { numeric: true })

export function compareFileNames(a: string, b: string): number {
  const primary = fileNameCollator.compare(a, b)
  if (primary !== 0) {
    return primary
  }
  // Why: numeric collation ties distinct names ("2" vs "02"); fall back to code
  // units so sibling order stays a total order instead of readdir order.
  return a < b ? -1 : a > b ? 1 : 0
}

/** Directories-first, then natural name order — the File Explorer listing contract. */
export function sortDirEntries<T extends { name: string; isDirectory: boolean }>(
  entries: T[]
): T[] {
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1
    }
    return compareFileNames(a.name, b.name)
  })
}
