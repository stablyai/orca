import { statSync } from 'node:fs'

/** What a secure-path cache entry remembers, so a later change to the path is detectable. */
export type HardenedPathCacheEntry = {
  isDirectory: boolean
  dev: number
  ino: number
  size: number
  mode: number
  ctimeMs: number
  mtimeMs: number
  birthtimeMs: number
}

/** Track mode directly as well as identity/timestamps so coarse ctime cannot hide chmod drift. */
export function getHardenedPathCacheEntry(
  targetPath: string,
  isDirectory: boolean
): HardenedPathCacheEntry | null {
  try {
    const stats = statSync(targetPath)
    if (stats.isDirectory() !== isDirectory) {
      return null
    }
    return {
      isDirectory,
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mode: stats.mode & 0o777,
      ctimeMs: stats.ctimeMs,
      mtimeMs: stats.mtimeMs,
      birthtimeMs: stats.birthtimeMs
    }
  } catch {
    return null
  }
}

/** True when two snapshots describe the same unchanged path (identity, mode, timestamps). */
export function hardenedPathCacheEntriesMatch(
  a: HardenedPathCacheEntry,
  b: HardenedPathCacheEntry
): boolean {
  return (
    a.isDirectory === b.isDirectory &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.ctimeMs === b.ctimeMs &&
    a.mtimeMs === b.mtimeMs &&
    a.birthtimeMs === b.birthtimeMs
  )
}
