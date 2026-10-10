import { constants, type Stats } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { extname } from 'node:path'
import { isBinaryBuffer } from './binary-buffer'
import { isPathInsideOrEqual } from './cross-platform-path'
import { IMAGE_FILE_MIME_TYPES } from './image-file-extensions'
import {
  NodeFileReadTooLargeError,
  readNodeFileHandleWithinLimit
} from './node-bounded-file-reader'

export const DOC_PREVIEW_PATH_AUTHORIZATION_ERROR = 'doc_preview_path_unauthorized'

export type DocPreviewFileAccessRequest = {
  boundaryPath: string
  entryPath: string
  implicitRootPath: string | null
  authorizedRootPaths: string[]
  targetPath: string
  maxTextBytes: number
  maxBinaryBytes: number
}

export type DocPreviewFileAccessResult = {
  content: string
  isBinary: boolean
  mimeType?: string
}

const DOC_PREVIEW_BINARY_MIME_TYPES: Record<string, string> = {
  ...IMAGE_FILE_MIME_TYPES,
  '.pdf': 'application/pdf'
}
const DOC_PREVIEW_MAX_TEXT_BYTES = 10 * 1024 * 1024
const DOC_PREVIEW_MAX_BINARY_BYTES = 50 * 1024 * 1024

const OPEN_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
// Why: opening a writer-less FIFO blocks before the regular-file check can refuse it, pinning a
// threadpool slot for good; non-blocking open returns at once and does not change regular-file reads.
const OPEN_NONBLOCK = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0

function authorizationError(): Error {
  return new Error(DOC_PREVIEW_PATH_AUTHORIZATION_ERROR)
}

function clampReadLimit(requested: number, maximum: number): number {
  if (!Number.isSafeInteger(requested) || requested < 0) {
    throw new RangeError('Document preview read limit must be a non-negative safe integer')
  }
  return Math.min(requested, maximum)
}

function sameFileIdentity(opened: Stats, current: Stats): boolean {
  return opened.dev === current.dev && opened.ino === current.ino
}

async function openAuthorizedDocPreviewTarget(
  request: DocPreviewFileAccessRequest
): Promise<{ handle: FileHandle; canonicalTarget: string }> {
  const [canonicalBoundary, canonicalEntry, canonicalTarget, canonicalImplicitRoot] =
    await Promise.all([
      realpath(request.boundaryPath),
      realpath(request.entryPath),
      realpath(request.targetPath),
      request.implicitRootPath === null ? Promise.resolve(null) : realpath(request.implicitRootPath)
    ])
  const canonicalAuthorizedRoots = await Promise.all(
    request.authorizedRootPaths.map((root) => realpath(root))
  )

  const entryAuthorized =
    isPathInsideOrEqual(canonicalBoundary, canonicalEntry) && canonicalTarget === canonicalEntry
  const implicitRootAuthorized =
    canonicalImplicitRoot !== null &&
    canonicalImplicitRoot !== canonicalBoundary &&
    isPathInsideOrEqual(canonicalBoundary, canonicalImplicitRoot) &&
    isPathInsideOrEqual(canonicalImplicitRoot, canonicalTarget)
  const explicitRootAuthorized = canonicalAuthorizedRoots.some(
    (root) =>
      isPathInsideOrEqual(canonicalBoundary, root) && isPathInsideOrEqual(root, canonicalTarget)
  )
  if (
    !isPathInsideOrEqual(canonicalBoundary, canonicalTarget) ||
    (!entryAuthorized && !implicitRootAuthorized && !explicitRootAuthorized)
  ) {
    throw authorizationError()
  }

  const handle = await open(canonicalTarget, constants.O_RDONLY | OPEN_NOFOLLOW | OPEN_NONBLOCK)
  try {
    const [openedStats, currentCanonicalTarget, currentTargetStats] = await Promise.all([
      handle.stat(),
      realpath(canonicalTarget),
      stat(canonicalTarget)
    ])
    if (
      !openedStats.isFile() ||
      currentCanonicalTarget !== canonicalTarget ||
      !sameFileIdentity(openedStats, currentTargetStats)
    ) {
      throw authorizationError()
    }
    return { handle, canonicalTarget }
  } catch (error) {
    await handle.close()
    throw error
  }
}

/** Canonicalizes, authorizes, opens, and reads on the filesystem's execution host. */
export async function readAuthorizedDocPreviewFile(
  request: DocPreviewFileAccessRequest
): Promise<DocPreviewFileAccessResult> {
  const { handle, canonicalTarget } = await openAuthorizedDocPreviewTarget(request)
  try {
    const mimeType = DOC_PREVIEW_BINARY_MIME_TYPES[extname(canonicalTarget).toLowerCase()]
    const { buffer } = await readNodeFileHandleWithinLimit(
      handle,
      mimeType
        ? clampReadLimit(request.maxBinaryBytes, DOC_PREVIEW_MAX_BINARY_BYTES)
        : clampReadLimit(request.maxTextBytes, DOC_PREVIEW_MAX_TEXT_BYTES)
    )
    if (mimeType) {
      return { content: buffer.toString('base64'), isBinary: true, mimeType }
    }
    return isBinaryBuffer(buffer)
      ? { content: '', isBinary: true }
      : { content: buffer.toString('utf8'), isBinary: false }
  } catch (error) {
    if (error instanceof NodeFileReadTooLargeError) {
      throw new Error('file_too_large')
    }
    throw error
  } finally {
    await handle.close()
  }
}
