import type { BigIntStats, CopyOptions } from 'node:fs'
import { chmod, copyFile, cp, lstat, mkdir, readdir, stat, unlink, utimes } from 'node:fs/promises'
import { dirname, join, parse, resolve, sep } from 'node:path'

// fs.cp opens every source folder with opendir, which can crash the process on Windows when the
// open fails (#50997); there, walk folders with readdir and copy files the way fs.cp does.
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
  if (!sourceStat.isDirectory() && (isRoot || !sourceStat.isFile())) {
    // Links and the root's own checks stay with fs.cp; it opens no folder for a non-folder.
    return cp(source, destination, { ...options, recursive: false, filter: undefined })
  }
  const destinationStat = await statPath(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  if (destinationStat && isSameFile(sourceStat, destinationStat)) {
    throw copyError('ERR_FS_CP_EINVAL', 'src and dest cannot be the same', destination)
  }
  if (sourceStat.isFile()) {
    return copyTreeFile(source, destination, sourceStat, destinationStat, options)
  }
  if (destinationStat && !destinationStat.isDirectory()) {
    throw copyError(
      'ERR_FS_CP_DIR_TO_NON_DIR',
      `cannot overwrite non-directory ${destination} with directory ${source}`,
      destination
    )
  }
  if (isRoot) {
    await assertNotCopyIntoSelf(source, sourceStat, destination)
  }
  // fs.cp defaults force to true.
  if (destinationStat && options.errorOnExist && options.force === false) {
    throw copyError('ERR_FS_CP_EEXIST', `${destination} already exists`, destination)
  }
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

// fs.cp's onFile: overwrite unless force is false, then copy the mode (and times when asked).
async function copyTreeFile(
  source: string,
  destination: string,
  sourceStat: BigIntStats,
  destinationStat: BigIntStats | null,
  options: CopyOptions
): Promise<void> {
  if (destinationStat) {
    if (destinationStat.isDirectory()) {
      throw copyError(
        'ERR_FS_CP_NON_DIR_TO_DIR',
        `cannot overwrite directory ${destination} with non-directory ${source}`,
        destination
      )
    }
    if (options.force === false) {
      if (options.errorOnExist) {
        throw copyError('ERR_FS_CP_EEXIST', `${destination} already exists`, destination)
      }
      return
    }
    await unlink(destination)
  }
  const mode = Number(sourceStat.mode)
  await copyFile(source, destination, options.mode)
  if (options.preserveTimestamps) {
    if ((mode & 0o200) === 0) {
      await chmod(destination, mode | 0o200)
    }
    const latest = await stat(source)
    await utimes(destination, latest.atime, latest.mtime)
  }
  await chmod(destination, mode)
}

// fs.cp's isSrcSubdir plus checkParentPaths: catches a destination reached through a junction.
async function assertNotCopyIntoSelf(
  source: string,
  sourceStat: BigIntStats,
  destination: string
): Promise<void> {
  const intoSelf = (): Error =>
    copyError(
      'ERR_FS_CP_EINVAL',
      `cannot copy ${source} to a subdirectory of self ${destination}`,
      destination
    )
  const sourceParts = resolve(source).split(sep).filter(Boolean)
  const destinationParts = resolve(destination).split(sep).filter(Boolean)
  if (sourceParts.every((part, index) => destinationParts[index] === part)) {
    throw intoSelf()
  }
  const sourceParent = resolve(dirname(source))
  for (
    let parent = resolve(dirname(destination));
    parent !== sourceParent && parent !== parse(parent).root;
    parent = dirname(parent)
  ) {
    const parentStat = await stat(parent, { bigint: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return null
        }
        throw error
      }
    )
    if (!parentStat) {
      return
    }
    if (isSameFile(sourceStat, parentStat)) {
      throw intoSelf()
    }
  }
}

function isSameFile(left: BigIntStats, right: BigIntStats): boolean {
  return Boolean(right.ino && right.dev && right.ino === left.ino && right.dev === left.dev)
}

function copyError(code: string, message: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code, path, syscall: 'cp' })
}
