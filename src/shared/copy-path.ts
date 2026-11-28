import type { BigIntStats, CopyOptions } from 'node:fs'
import { chmod, cp, lstat, mkdir, readdir, stat, utimes } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

// fs.cp opens every source folder with opendir, which can crash the process on Windows when the
// open fails (#50997); there, walk folders with readdir and leave files and links to fs.cp.
export async function copyPath(
  source: string,
  destination: string,
  options?: CopyOptions
): Promise<void> {
  if (process.platform !== 'win32' || !options?.recursive) {
    return cp(source, destination, options)
  }
  return copyTreeEntry(source, destination, options, true)
}

async function copyTreeEntry(
  source: string,
  destination: string,
  options: CopyOptions,
  isRoot: boolean
): Promise<void> {
  if (options.filter && !(await options.filter(source, destination))) {
    return
  }
  const statPath = (path: string): Promise<BigIntStats> =>
    options.dereference ? stat(path, { bigint: true }) : lstat(path, { bigint: true })
  const sourceStat = await statPath(source)
  if (!sourceStat.isDirectory()) {
    // fs.cp opens no folder for a file or a link.
    return cp(source, destination, { ...options, filter: undefined })
  }
  const destinationStat = await statPath(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  assertDirectoryCopyAllowed(source, destination, sourceStat, destinationStat, options, isRoot)
  if (!destinationStat) {
    await mkdir(destination, { recursive: isRoot })
  }
  for (const name of await readdir(source)) {
    await copyTreeEntry(join(source, name), join(destination, name), options, false)
  }
  if (options.preserveTimestamps) {
    const latest = await stat(source)
    await utimes(destination, latest.atime, latest.mtime)
  }
  if (!destinationStat) {
    await chmod(destination, Number(sourceStat.mode))
  }
}

// Same checks and error codes as fs.cp for a folder source.
function assertDirectoryCopyAllowed(
  source: string,
  destination: string,
  sourceStat: BigIntStats,
  destinationStat: BigIntStats | null,
  options: CopyOptions,
  isRoot: boolean
): void {
  if (destinationStat) {
    if (
      destinationStat.ino &&
      destinationStat.dev &&
      destinationStat.ino === sourceStat.ino &&
      destinationStat.dev === sourceStat.dev
    ) {
      throw copyError('ERR_FS_CP_EINVAL', 'src and dest cannot be the same', destination)
    }
    if (!destinationStat.isDirectory()) {
      throw copyError(
        'ERR_FS_CP_DIR_TO_NON_DIR',
        `cannot overwrite non-directory ${destination} with directory ${source}`,
        destination
      )
    }
  }
  if (isRoot && isSameOrInside(source, destination)) {
    throw copyError(
      'ERR_FS_CP_EINVAL',
      `cannot copy ${source} to a subdirectory of self ${destination}`,
      destination
    )
  }
  if (destinationStat && options.errorOnExist && !options.force) {
    throw copyError('ERR_FS_CP_EEXIST', `${destination} already exists`, destination)
  }
}

function isSameOrInside(parent: string, candidate: string): boolean {
  const parentParts = resolve(parent).split(sep).filter(Boolean)
  const candidateParts = resolve(candidate).split(sep).filter(Boolean)
  return parentParts.every((part, index) => candidateParts[index] === part)
}

function copyError(code: string, message: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code, path, syscall: 'cp' })
}
