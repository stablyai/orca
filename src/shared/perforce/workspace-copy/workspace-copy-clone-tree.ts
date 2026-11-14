import { constants } from 'node:fs'
import { copyFile, mkdir, readdir, readlink, stat, symlink, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export type TreeExclusions = { folders: readonly string[]; files: readonly string[] }

export type TreeCopyResult =
  | {
      ok: true
      files: number | null
      bytes: number | null
      /** True when every file is known to be a clone; null when only free space can tell. */
      cloned: boolean | null
    }
  | { ok: false; message: string; notCloning?: boolean }

const PARALLEL_COPIES = 16
// Errors copyfile(3) gives when the volume cannot clone (not APFS, or another volume).
const NOT_CLONING_CODES = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'])

function key(path: string): string {
  // Why lower case: copies are only made on case-insensitive volumes.
  return resolve(path).toLowerCase()
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

/**
 * Copies a workspace tree file by file as copy-on-write clones (clonefile on APFS). Symbolic links
 * are recreated, never followed, and file and folder modification times are kept: Unity decides from
 * them whether the copied Library is still valid. `copyMode` is for tests on volumes that cannot clone.
 */
export async function cloneTree(
  source: string,
  destination: string,
  exclusions: TreeExclusions,
  copyMode: number = constants.COPYFILE_FICLONE_FORCE
): Promise<TreeCopyResult> {
  const skipFolders = new Set(exclusions.folders.map(key))
  const skipFiles = new Set(exclusions.files.map(key))
  const files: [string, string][] = []
  const folders: [string, string][] = []
  const failures: string[] = []
  const pending: [string, string][] = [[source, destination]]
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [from, to] = next
    await mkdir(to, { recursive: true })
    folders.push(next)
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const entryFrom = join(from, entry.name)
      const entryTo = join(to, entry.name)
      if (entry.isSymbolicLink()) {
        await symlink(await readlink(entryFrom), entryTo).catch((error: unknown) =>
          failures.push(`${entryFrom}: ${String(error)}`)
        )
      } else if (entry.isDirectory()) {
        if (!skipFolders.has(key(entryFrom))) {
          pending.push([entryFrom, entryTo])
        }
      } else if (entry.isFile() && !skipFiles.has(key(entryFrom))) {
        files.push([entryFrom, entryTo])
      }
    }
  }
  let bytes = 0
  let notCloning = false
  let index = 0
  const worker = async (): Promise<void> => {
    // Why stop on a refused clone: every other file would be refused the same way.
    while (index < files.length && !notCloning) {
      const [from, to] = files[index++]
      try {
        await copyFile(from, to, constants.COPYFILE_EXCL | copyMode)
        const [original, copied] = await Promise.all([stat(from), stat(to)])
        bytes += original.size
        if (copied.mtimeMs !== original.mtimeMs) {
          await utimes(to, original.atime, original.mtime)
        }
      } catch (error) {
        notCloning ||= NOT_CLONING_CODES.has(errorCode(error) ?? '')
        failures.push(`${from}: ${String(error)}`)
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL_COPIES }, worker))
  if (failures.length > 0) {
    return {
      ok: false,
      notCloning,
      message: notCloning
        ? 'The volume did not clone the files (it is not APFS), so a copy would duplicate every byte.'
        : `${failures.length} file(s) could not be copied: ${failures.slice(0, 3).join('; ')}`
    }
  }
  // Writing into a folder moves its time, so folder times are set last, deepest first.
  for (const [from, to] of folders.toReversed()) {
    const original = await stat(from)
    await utimes(to, original.atime, original.mtime)
  }
  return {
    ok: true,
    files: files.length,
    bytes,
    cloned: copyMode === constants.COPYFILE_FICLONE_FORCE ? true : null
  }
}
