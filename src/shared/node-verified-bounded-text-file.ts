import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

const OPEN_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0

export type VerifiedBoundedTextFileOptions = {
  maxBytes: number
  expectedRootRealPath: string
}

export async function readVerifiedBoundedTextFile(
  filePath: string,
  options: VerifiedBoundedTextFileOptions
): Promise<string> {
  const maxBytes = validatedByteLimit(options.maxBytes)
  const resolvedFilePath = await realpath(filePath)
  if (!isPathInsideRoot(options.expectedRootRealPath, resolvedFilePath)) {
    throw new Error('verified_file_outside_root')
  }
  const lexicalRoot = await findLexicalRoot(filePath, options.expectedRootRealPath)
  const beforeOpen = await assertRegularDescendantPath(lexicalRoot, filePath)
  const handle = await openNoFollow(filePath)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFileIdentity(beforeOpen, opened)) {
      throw new Error('verified_file_changed')
    }
    return (await readBoundedFileHandle(handle, maxBytes)).toString('utf8')
  } finally {
    await handle.close()
  }
}

async function findLexicalRoot(filePath: string, expectedRootRealPath: string): Promise<string> {
  let candidate = dirname(filePath)
  for (let depth = 0; depth < 256; depth += 1) {
    if (samePath(await realpath(candidate), expectedRootRealPath)) {
      return candidate
    }
    const parent = dirname(candidate)
    if (parent === candidate) {
      break
    }
    candidate = parent
  }
  throw new Error('verified_file_outside_root')
}

async function assertRegularDescendantPath(rootPath: string, filePath: string): Promise<Stats> {
  const segments = relative(rootPath, filePath).split(sep).filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new Error('verified_file_outside_root')
  }
  let current = rootPath
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index])
    const stats = await lstat(current)
    if (stats.isSymbolicLink()) {
      throw new Error('verified_file_changed')
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error('verified_file_changed')
    }
    if (index === segments.length - 1) {
      if (!stats.isFile()) {
        throw new Error('verified_file_not_regular')
      }
      return stats
    }
  }
  throw new Error('verified_file_not_regular')
}

export async function readBoundedFileHandle(handle: FileHandle, maxBytes: number): Promise<Buffer> {
  const safeLimit = validatedByteLimit(maxBytes)
  const buffer = Buffer.alloc(safeLimit + 1)
  let totalBytesRead = 0
  while (totalBytesRead < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      totalBytesRead,
      buffer.length - totalBytesRead,
      totalBytesRead
    )
    if (bytesRead === 0) {
      break
    }
    totalBytesRead += bytesRead
  }
  if (totalBytesRead > safeLimit) {
    throw new Error('file_too_large')
  }
  return buffer.subarray(0, totalBytesRead)
}

export async function openNoFollow(filePath: string): Promise<FileHandle> {
  try {
    return await open(filePath, constants.O_RDONLY | OPEN_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('verified_file_changed')
    }
    throw error
  }
}

function validatedByteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 0x7fffffff) {
    throw new Error('invalid_bounded_file_limit')
  }
  return value
}

function isPathInsideRoot(rootRealPath: string, fileRealPath: string): boolean {
  const difference = relative(rootRealPath, fileRealPath)
  return (
    difference !== '' &&
    !isAbsolute(difference) &&
    difference !== '..' &&
    !difference.startsWith(`..${sep}`)
  )
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === ''
}

function sameFileIdentity(beforeOpen: Stats, opened: Stats): boolean {
  if (
    Number.isFinite(beforeOpen.dev) &&
    Number.isFinite(beforeOpen.ino) &&
    Number.isFinite(opened.dev) &&
    Number.isFinite(opened.ino)
  ) {
    return beforeOpen.dev === opened.dev && beforeOpen.ino === opened.ino
  }
  return beforeOpen.size === opened.size && beforeOpen.mtimeMs === opened.mtimeMs
}
