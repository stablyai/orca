import { lstat } from 'fs/promises'
import type { Stats } from 'fs'
import { basename, dirname } from 'path'

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

function isCaseOnlySameParentRename(oldPath: string, newPath: string): boolean {
  const oldBasename = basename(oldPath)
  const newBasename = basename(newPath)
  return (
    dirname(oldPath) === dirname(newPath) &&
    oldBasename !== newBasename &&
    caseFoldFileExplorerBasename(oldBasename) === caseFoldFileExplorerBasename(newBasename)
  )
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
  if (hasSameFilesystemIdentity(oldStat, newStat) && isCaseOnlySameParentRename(oldPath, newPath)) {
    return
  }

  throw new Error(`A file or folder named '${basename(newPath)}' already exists in this location`)
}
