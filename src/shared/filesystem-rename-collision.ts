import { lstat, realpath } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, dirname } from 'node:path'

function isENOENT(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function caseFoldFileExplorerBasename(name: string): string {
  // Why: APFS may surface canonically equivalent Unicode names in different forms.
  // Node has no filesystem-native collation API here, so this is best-effort.
  return name.normalize('NFC').toLowerCase()
}

function hasSameFilesystemIdentity(oldStat: Stats, newStat: Stats): boolean {
  return oldStat.dev === newStat.dev && oldStat.ino === newStat.ino
}

async function isSameDirectoryEntryRename(
  oldPath: string,
  newPath: string,
  oldStat: Stats,
  newStat: Stats
): Promise<boolean> {
  const oldBasename = basename(oldPath)
  const newBasename = basename(newPath)
  if (!hasSameFilesystemIdentity(oldStat, newStat) || dirname(oldPath) !== dirname(newPath)) {
    return false
  }
  if (oldPath === newPath) {
    return true
  }
  try {
    const [oldRealPath, newRealPath] = await Promise.all([realpath(oldPath), realpath(newPath)])
    return oldRealPath === newRealPath
  } catch (error) {
    // Preserve case-only renames for dangling symlinks, which realpath cannot resolve.
    if (!isENOENT(error)) {
      throw error
    }
    return (
      oldBasename !== newBasename &&
      caseFoldFileExplorerBasename(oldBasename) === caseFoldFileExplorerBasename(newBasename)
    )
  }
}

export async function assertNoClobberRenameDestinationAvailable(
  oldPath: string,
  newPath: string
): Promise<void> {
  let newStat: Stats
  try {
    newStat = await lstat(newPath)
  } catch (error) {
    if (isENOENT(error)) {
      return
    }
    throw error
  }

  const oldStat = await lstat(oldPath)
  if (await isSameDirectoryEntryRename(oldPath, newPath, oldStat, newStat)) {
    return
  }

  throw new Error(`A file or folder named '${basename(newPath)}' already exists in this location`)
}
