import { constants as fsConstants } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDefinitiveAbsence } from './definitive-filesystem-absence'

// Why: git reports paths with '/', so split before joining with the host separator.
function resolveEntryPath(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'))
}

export async function sumNodeEntrySizes(
  root: string,
  relativePaths: readonly string[]
): Promise<number> {
  let total = 0
  for (const relativePath of relativePaths) {
    total += (await lstat(resolveEntryPath(root, relativePath))).size
  }
  return total
}

export async function copyNodeWorkingTreeEntry(
  fromRoot: string,
  toRoot: string,
  relativePath: string
): Promise<void> {
  const from = resolveEntryPath(fromRoot, relativePath)
  const to = resolveEntryPath(toRoot, relativePath)
  await mkdir(dirname(to), { recursive: true })
  const stats = await lstat(from)
  if (stats.isSymbolicLink()) {
    await symlink(await readlink(from), to)
    return
  }
  await copyFile(from, to, fsConstants.COPYFILE_EXCL)
  await chmod(to, stats.mode)
}

export async function removeNodeWorkingTreeEntry(
  root: string,
  relativePath: string
): Promise<void> {
  // Why: no `recursive` so an unexpected directory errors instead of being deleted wholesale.
  await rm(resolveEntryPath(root, relativePath), { force: true })
}

export async function nodeWorkingTreeEntryExists(
  root: string,
  relativePath: string
): Promise<boolean> {
  try {
    await lstat(resolveEntryPath(root, relativePath))
    return true
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return false
    }
    throw error
  }
}
