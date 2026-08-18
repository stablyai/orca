import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { relativePathInsideRoot } from './cross-platform-path'

const OPEN_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export type VerifiedBoundedTextFileOptions = {
  maxBytes: number
  expectedRootRealPath: string
  io?: VerifiedBoundedTextFileIo
}

export type VerifiedBoundedTextFileHandle = Pick<FileHandle, 'close' | 'read' | 'stat'>

export type VerifiedBoundedTextFileIo = {
  realpath: (path: string) => Promise<string>
  lstat: (path: string) => Promise<Stats>
  open: (path: string) => Promise<VerifiedBoundedTextFileHandle>
}

const defaultVerifiedBoundedTextFileIo: VerifiedBoundedTextFileIo = {
  realpath,
  lstat,
  open: (filePath) => open(filePath, constants.O_RDONLY | OPEN_NOFOLLOW)
}

export async function readVerifiedBoundedTextFile(
  filePath: string,
  options: VerifiedBoundedTextFileOptions
): Promise<string> {
  const maxBytes = validatedByteLimit(options.maxBytes)
  const io = options.io ?? defaultVerifiedBoundedTextFileIo
  const resolvedFilePath = await io.realpath(filePath)
  if (!isVerifiedFileDescendant(options.expectedRootRealPath, resolvedFilePath)) {
    throw new Error('verified_file_outside_root')
  }
  const lexicalRoot = await findLexicalRoot(filePath, options.expectedRootRealPath, io)
  const beforeOpen = await assertRegularDescendantPath(lexicalRoot, filePath, io)
  const handle = await openNoFollow(filePath, io)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameFileIdentity(beforeOpen, opened)) {
      throw new Error('verified_file_changed')
    }
    const bytes = await readBoundedFileHandle(handle, maxBytes)
    try {
      return STRICT_UTF8_DECODER.decode(bytes)
    } catch {
      throw new Error('invalid_utf8')
    }
  } finally {
    await handle.close()
  }
}

async function findLexicalRoot(
  filePath: string,
  expectedRootRealPath: string,
  io: VerifiedBoundedTextFileIo
): Promise<string> {
  let candidate = dirname(filePath)
  for (let depth = 0; depth < 256; depth += 1) {
    if (samePath(await io.realpath(candidate), expectedRootRealPath)) {
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

async function assertRegularDescendantPath(
  rootPath: string,
  filePath: string,
  io: VerifiedBoundedTextFileIo
): Promise<Stats> {
  const segments = relative(rootPath, filePath).split(sep).filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw new Error('verified_file_outside_root')
  }
  let current = rootPath
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index])
    const stats = await io.lstat(current)
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

export async function readBoundedFileHandle(
  handle: Pick<FileHandle, 'read'>,
  maxBytes: number
): Promise<Buffer> {
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

export function isVerifiedBoundedTextFileTooLargeError(error: unknown): boolean {
  return error instanceof Error && error.message === 'file_too_large'
}

export async function openNoFollow(
  filePath: string,
  io: VerifiedBoundedTextFileIo = defaultVerifiedBoundedTextFileIo
): Promise<VerifiedBoundedTextFileHandle> {
  try {
    return await io.open(filePath)
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

export function isVerifiedFileDescendant(rootRealPath: string, fileRealPath: string): boolean {
  const difference = relativePathInsideRoot(rootRealPath, fileRealPath)
  return difference !== null && difference !== ''
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === ''
}

function sameFileIdentity(beforeOpen: Stats, opened: Stats): boolean {
  const beforeHasIdentity = hasStableFileIdentity(beforeOpen)
  const openedHasIdentity = hasStableFileIdentity(opened)
  if (!beforeHasIdentity || !openedHasIdentity) {
    return false
  }
  return beforeOpen.dev === opened.dev && beforeOpen.ino === opened.ino
}

function hasStableFileIdentity(stats: Stats): boolean {
  return (
    stats.dev !== 0 && stats.ino !== 0 && Number.isFinite(stats.dev) && Number.isFinite(stats.ino)
  )
}
