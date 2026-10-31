import { constants, type Stats } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { extname } from 'node:path'
import { isBinaryBuffer } from './binary-buffer'
import { isPathInsideOrEqual } from './cross-platform-path'
import { IMAGE_FILE_MIME_TYPES } from './image-file-extensions'
import { FONT_FILE_MIME_TYPES } from './font-file-extensions'
import type { RuntimeFileReadChunkResult } from './runtime-file-contracts'
import {
  NodeFileReadTooLargeError,
  readNodeFileHandleWithinLimit
} from './node-bounded-file-reader'

export const DOC_PREVIEW_PATH_AUTHORIZATION_ERROR = 'doc_preview_path_unauthorized'
export const DOC_PREVIEW_FILE_CHANGED_MESSAGE =
  'This document changed while it was loading. Reload the preview to see the latest version.'

export type DocPreviewFileTarget = {
  boundaryPath: string
  entryPath: string
  implicitRootPath: string | null
  authorizedRootPaths: string[]
  targetPath: string
}

export type DocPreviewFileAccessRequest = DocPreviewFileTarget & {
  maxTextBytes: number
  maxBinaryBytes: number
}

/** One range of a preview file, with the opened file's version so a reader can refuse a rewrite mid-read. */
export type DocPreviewFileChunk = RuntimeFileReadChunkResult & {
  size: number
  mtimeMs: number
  ctimeMs: number
  /** Set for the image, font and PDF types a whole read serves as base64; text otherwise. */
  mimeType?: string
}

export type DocPreviewFileAccessResult = {
  content: string
  isBinary: boolean
  mimeType?: string
}

const DOC_PREVIEW_BINARY_MIME_TYPES: Record<string, string> = {
  ...IMAGE_FILE_MIME_TYPES,
  ...FONT_FILE_MIME_TYPES,
  '.pdf': 'application/pdf'
}
const DOC_PREVIEW_MAX_TEXT_BYTES = 10 * 1024 * 1024
const DOC_PREVIEW_MAX_BINARY_BYTES = 50 * 1024 * 1024

const OPEN_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
// Nonblocking open prevents writer-less FIFOs pinning a threadpool slot before regular-file checks; regular reads are unaffected.
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

function docPreviewBinaryMimeType(filePath: string): string | undefined {
  return DOC_PREVIEW_BINARY_MIME_TYPES[extname(filePath).toLowerCase()]
}

async function openAuthorizedDocPreviewTarget(
  request: DocPreviewFileTarget
): Promise<{ handle: FileHandle; canonicalTarget: string; stats: Stats }> {
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
    return { handle, canonicalTarget, stats: openedStats }
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
    const mimeType = docPreviewBinaryMimeType(canonicalTarget)
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

/** A range of a file too large for one reply, under the same authorization and size caps as a whole read. */
export async function readAuthorizedDocPreviewFileChunk(
  request: DocPreviewFileTarget,
  offset: number,
  length: number
): Promise<DocPreviewFileChunk> {
  const { handle, canonicalTarget, stats } = await openAuthorizedDocPreviewTarget(request)
  try {
    const mimeType = docPreviewBinaryMimeType(canonicalTarget)
    if (stats.size > (mimeType ? DOC_PREVIEW_MAX_BINARY_BYTES : DOC_PREVIEW_MAX_TEXT_BYTES)) {
      throw new Error('file_too_large')
    }
    const buffer = Buffer.alloc(Math.min(length, Math.max(0, stats.size - offset)))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    // Why: the reader compares versions across chunks, so a rewrite during this read must surface here.
    const after = await handle.stat()
    if (
      after.size !== stats.size ||
      after.mtimeMs !== stats.mtimeMs ||
      after.ctimeMs !== stats.ctimeMs
    ) {
      throw new Error(DOC_PREVIEW_FILE_CHANGED_MESSAGE)
    }
    return {
      contentBase64: buffer.subarray(0, bytesRead).toString('base64'),
      bytesRead,
      eof: offset + bytesRead >= stats.size,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
      ...(mimeType ? { mimeType } : {})
    }
  } finally {
    await handle.close()
  }
}
